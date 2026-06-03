-- 012: Pricing config table + grace period + resolve_payment_price with allowed_provider
-- ========================================================================================
-- Replaces the hardcoded constants in 011 with a single source-of-truth table.
--
-- Architectural changes vs 011:
--   1. pricing_config table — single configurable row holding standard prices
--      and founding-discount percentage. Founding prices are COMPUTED from
--      standard prices × (1 - discount_pct/100), not hardcoded.
--
--   2. Grace period — when standard prices are raised via UPDATE, the previous
--      values are auto-copied to prev_standard_* fields with prev_active_until
--      = now() + 30 days. During that 30-day window, founding members continue
--      paying the OLD founding price (which was 0.7 × old standard). After that
--      window, they pay 0.7 × new standard.
--
--   3. resolve_payment_price now returns allowed_provider:
--        locale='ru' → 'yookassa'
--        locale='en' → 'stars'
--        no founding → null (any)
--
--   4. founding_pricing_config view is reshaped to read from pricing_config.
--
-- All RPCs remain SECURITY DEFINER, locked to service_role.

BEGIN;

-- ---------------------------------------------------------------------------
-- A) pricing_config — singleton config table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.pricing_config (
  id                       int PRIMARY KEY DEFAULT 1,
  -- Current (active) prices
  standard_rub             int           NOT NULL,
  standard_usd             numeric(6,2)  NOT NULL,
  standard_stars           int           NOT NULL,
  founding_discount_pct    numeric(5,2)  NOT NULL DEFAULT 30.00,
  -- Previous prices, in effect for founding members only, until prev_active_until
  prev_standard_rub        int,
  prev_standard_usd        numeric(6,2),
  prev_standard_stars      int,
  prev_active_until        timestamptz,
  -- Audit
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid REFERENCES auth.users(id),
  CONSTRAINT pricing_config_singleton CHECK (id = 1)
);

-- Seed with current values (only if table is empty)
INSERT INTO public.pricing_config (id, standard_rub, standard_usd, standard_stars, founding_discount_pct)
VALUES (1, 1500, 15.00, 956, 30.00)
ON CONFLICT (id) DO NOTHING;

-- Lock down: this table is admin-managed via RPC, not direct UPDATE from clients
ALTER TABLE public.pricing_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pricing_config FROM anon, authenticated;
-- Service role bypasses RLS; admins use update_pricing_config() RPC below.

-- Public read via the view (founding_pricing_config) — direct SELECT is admin-only

-- ---------------------------------------------------------------------------
-- B) Trigger: when standard_* changes, snapshot previous values for 30-day grace
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tg_pricing_config_grace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  -- Detect a standard-price change
  IF (NEW.standard_rub   IS DISTINCT FROM OLD.standard_rub) OR
     (NEW.standard_usd   IS DISTINCT FROM OLD.standard_usd) OR
     (NEW.standard_stars IS DISTINCT FROM OLD.standard_stars) THEN

    -- Snapshot previous values; founding users keep paying the OLD founding price
    -- (= OLD standard × (1 - discount_pct/100)) until prev_active_until.
    NEW.prev_standard_rub   := OLD.standard_rub;
    NEW.prev_standard_usd   := OLD.standard_usd;
    NEW.prev_standard_stars := OLD.standard_stars;
    NEW.prev_active_until   := now() + interval '30 days';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS tg_pricing_config_grace ON public.pricing_config;
CREATE TRIGGER tg_pricing_config_grace
  BEFORE UPDATE ON public.pricing_config
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_pricing_config_grace();

-- ---------------------------------------------------------------------------
-- C) update_pricing_config — admin-only RPC for raising prices safely
-- ---------------------------------------------------------------------------
-- Use this instead of direct UPDATE. It calls auth.uid() to record who.

CREATE OR REPLACE FUNCTION public.update_pricing_config(
  p_standard_rub   int  DEFAULT NULL,
  p_standard_usd   numeric DEFAULT NULL,
  p_standard_stars int  DEFAULT NULL,
  p_founding_discount_pct numeric DEFAULT NULL,
  p_notes          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $function$
DECLARE
  v_row pricing_config%ROWTYPE;
BEGIN
  IF NOT public.is_admin_user(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';
  END IF;

  UPDATE public.pricing_config
     SET standard_rub          = COALESCE(p_standard_rub,   standard_rub),
         standard_usd          = COALESCE(p_standard_usd,   standard_usd),
         standard_stars        = COALESCE(p_standard_stars, standard_stars),
         founding_discount_pct = COALESCE(p_founding_discount_pct, founding_discount_pct),
         updated_by            = auth.uid()
   WHERE id = 1
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok', true,
    'config', to_jsonb(v_row),
    'notes', p_notes
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.update_pricing_config(int, numeric, int, numeric, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.update_pricing_config(int, numeric, int, numeric, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- D) Drop and recreate founding_pricing_config view to read from pricing_config
-- ---------------------------------------------------------------------------

DROP VIEW IF EXISTS public.founding_pricing_config;

CREATE OR REPLACE VIEW public.founding_pricing_config AS
SELECT
  c.standard_rub,
  -- Founding price = standard × (1 - discount_pct/100), rounded to nearest int
  ROUND(c.standard_rub   * (1 - c.founding_discount_pct/100.0))::int AS founding_rub,
  c.standard_usd,
  ROUND(c.standard_usd   * (1 - c.founding_discount_pct/100.0), 2)   AS founding_usd,
  c.standard_stars,
  ROUND(c.standard_stars * (1 - c.founding_discount_pct/100.0))::int AS founding_stars,
  c.founding_discount_pct AS discount_pct,
  -- Grace info — for admin diagnostics
  c.prev_standard_rub,
  CASE WHEN c.prev_standard_rub IS NOT NULL
       THEN ROUND(c.prev_standard_rub * (1 - c.founding_discount_pct/100.0))::int
       ELSE NULL END AS prev_founding_rub,
  c.prev_standard_usd,
  CASE WHEN c.prev_standard_usd IS NOT NULL
       THEN ROUND(c.prev_standard_usd * (1 - c.founding_discount_pct/100.0), 2)
       ELSE NULL END AS prev_founding_usd,
  c.prev_standard_stars,
  CASE WHEN c.prev_standard_stars IS NOT NULL
       THEN ROUND(c.prev_standard_stars * (1 - c.founding_discount_pct/100.0))::int
       ELSE NULL END AS prev_founding_stars,
  c.prev_active_until,
  c.updated_at
FROM public.pricing_config c
WHERE c.id = 1;

ALTER VIEW public.founding_pricing_config SET (security_invoker = on);
GRANT SELECT ON public.founding_pricing_config TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- E) Rewrite resolve_payment_price — config-driven + grace + allowed_provider
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_payment_price(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_is_founding boolean;
  v_user_lang   text;
  v_user_locale text;
  v_claim_locale text;
  v_claim_active boolean;
  v_quota_remaining int;
  v_amount_rub  int;
  v_amount_usd  numeric(6,2);
  v_amount_stars int;
  v_locale      text;
  v_intent      boolean := false;
  v_allowed_provider text := null;
  -- pricing_config snapshot
  v_std_rub     int;
  v_std_usd     numeric(6,2);
  v_std_stars   int;
  v_disc        numeric(5,2);
  v_prev_rub    int;
  v_prev_usd    numeric(6,2);
  v_prev_stars  int;
  v_prev_until  timestamptz;
  v_in_grace    boolean := false;
  v_eff_rub     int;
  v_eff_usd     numeric(6,2);
  v_eff_stars   int;
BEGIN
  -- 1. Load current pricing config
  SELECT standard_rub, standard_usd, standard_stars, founding_discount_pct,
         prev_standard_rub, prev_standard_usd, prev_standard_stars, prev_active_until
    INTO v_std_rub, v_std_usd, v_std_stars, v_disc,
         v_prev_rub, v_prev_usd, v_prev_stars, v_prev_until
  FROM public.pricing_config WHERE id = 1;

  -- Grace window check: founding users use PREVIOUS standard as base for discount
  -- until prev_active_until.
  v_in_grace := (v_prev_until IS NOT NULL AND v_prev_until > now() AND v_prev_rub IS NOT NULL);

  -- Effective standard for THIS user's founding discount calc
  IF v_in_grace THEN
    v_eff_rub   := v_prev_rub;
    v_eff_usd   := v_prev_usd;
    v_eff_stars := v_prev_stars;
  ELSE
    v_eff_rub   := v_std_rub;
    v_eff_usd   := v_std_usd;
    v_eff_stars := v_std_stars;
  END IF;

  -- Default: standard (non-founding) pricing — ALWAYS uses current standard,
  -- never prev_*. Grace only applies to founding members.
  v_amount_rub   := v_std_rub;
  v_amount_usd   := v_std_usd;
  v_amount_stars := v_std_stars;
  v_locale       := null;

  -- 2. Load profile
  SELECT founding_member, COALESCE(founding_locale, lang)
    INTO v_is_founding, v_user_locale
  FROM public.profiles WHERE id = p_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'profile_not_found',
      'amount_rub',   v_amount_rub,
      'amount_usd',   v_amount_usd,
      'amount_stars', v_amount_stars,
      'founding_intent', false,
      'allowed_provider', null,
      'in_grace_period', v_in_grace
    );
  END IF;

  -- 3. Already founding → founding discount on effective base, locked provider by locale
  IF v_is_founding THEN
    v_amount_rub   := ROUND(v_eff_rub   * (1 - v_disc/100.0))::int;
    v_amount_usd   := ROUND(v_eff_usd   * (1 - v_disc/100.0), 2);
    v_amount_stars := ROUND(v_eff_stars * (1 - v_disc/100.0))::int;
    v_locale       := v_user_locale;
    v_allowed_provider := CASE v_user_locale WHEN 'ru' THEN 'yookassa' WHEN 'en' THEN 'stars' ELSE NULL END;

    RETURN jsonb_build_object(
      'ok', true,
      'amount_rub',   v_amount_rub,
      'amount_usd',   v_amount_usd,
      'amount_stars', v_amount_stars,
      'founding_intent', false,
      'already_founding', true,
      'locale', v_locale,
      'allowed_provider', v_allowed_provider,
      'in_grace_period', v_in_grace,
      'discount_pct', v_disc
    );
  END IF;

  -- 4. Active pending claim? → founding intent, founding discount, locked provider
  SELECT locale, (expires_at > now())
    INTO v_claim_locale, v_claim_active
  FROM public.pending_founding_claims WHERE user_id = p_user_id;

  IF v_claim_active THEN
    SELECT cap - claimed INTO v_quota_remaining
    FROM public.founding_quota WHERE locale = v_claim_locale;

    IF COALESCE(v_quota_remaining, 0) > 0 THEN
      -- For NEW founding (intent), the founding price = current standard × (1 - disc/100)
      -- No grace — grace only applies to ALREADY-founding users after a price hike.
      v_amount_rub   := ROUND(v_std_rub   * (1 - v_disc/100.0))::int;
      v_amount_usd   := ROUND(v_std_usd   * (1 - v_disc/100.0), 2);
      v_amount_stars := ROUND(v_std_stars * (1 - v_disc/100.0))::int;
      v_locale       := v_claim_locale;
      v_intent       := true;
      v_allowed_provider := CASE v_claim_locale WHEN 'ru' THEN 'yookassa' WHEN 'en' THEN 'stars' ELSE NULL END;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'amount_rub',   v_amount_rub,
    'amount_usd',   v_amount_usd,
    'amount_stars', v_amount_stars,
    'founding_intent', v_intent,
    'already_founding', false,
    'locale', v_locale,
    'allowed_provider', v_allowed_provider,
    'in_grace_period', false,    -- non-founding never in grace
    'discount_pct', CASE WHEN v_intent THEN v_disc ELSE NULL END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_payment_price(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.resolve_payment_price(uuid) TO service_role;

COMMIT;

-- 011: Founding pricing & intent tracking
-- =========================================
-- Adds the missing pieces between founding-DB-infrastructure (010) and the
-- payment-collection layer (Yookassa + Telegram Stars):
--
--   1. pending_founding_claims          — intent-to-pay table, TTL 24h
--   2. ensure_pending_founding_claim()  — bot calls this when user clicks /start founding
--   3. resolve_payment_price()          — single source of truth for prices (RU+EN)
--   4. apply_stars_payment()            — fix trial-extension bug (parity with apply_successful_payment)
--   5. founding_pricing_config view     — single place to read current prices (for marketing/admin)
--
-- After this migration:
--   • create-payment / Stars invoice both consult resolve_payment_price(user_id)
--   • webhook / Stars success handler call claim_founding_slot(...) when founding_intent=true
--   • Stars payments now correctly respect trial periods
--
-- All RPCs are SECURITY DEFINER, locked down to service_role (bot/edge functions
-- only) — never callable from anon/authenticated browser sessions.

BEGIN;

-- ---------------------------------------------------------------------------
-- A) pending_founding_claims — short-TTL intent table
-- ---------------------------------------------------------------------------
-- One row per user. Created when bot sees /start founding. TTL 24h: if user
-- doesn't pay within 24h, the founding-pricing intent expires and they fall
-- back to standard pricing. Prevents accidental discount drift on stale clicks.

CREATE TABLE IF NOT EXISTS public.pending_founding_claims (
  user_id    uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  locale     text NOT NULL CHECK (locale IN ('ru','en')),
  source     text,                                  -- 'tg_deeplink_ru','tg_deeplink_en','web', ...
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);

CREATE INDEX IF NOT EXISTS idx_pending_founding_claims_expires
  ON public.pending_founding_claims(expires_at);

-- RLS: service_role bypasses RLS; lock out everyone else.
ALTER TABLE public.pending_founding_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pending_founding_claims FROM anon, authenticated;

-- No policies → no access for anon/authenticated. Edge functions use service_role.

-- ---------------------------------------------------------------------------
-- B) ensure_pending_founding_claim — bot calls this on /start founding
-- ---------------------------------------------------------------------------
-- UPSERTs a pending claim and renews expires_at to now()+24h.
-- Only callable via service_role (bot uses SUPABASE_SERVICE_ROLE_KEY through
-- its REST helper). Never granted to anon/authenticated.

CREATE OR REPLACE FUNCTION public.ensure_pending_founding_claim(
  p_user_id uuid,
  p_locale  text,
  p_source  text DEFAULT 'tg_deeplink'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $function$
DECLARE
  v_remaining int;
  v_cap       int;
  v_claimed   int;
  v_already   boolean;
BEGIN
  IF p_locale NOT IN ('ru','en') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_locale');
  END IF;

  -- Skip if user is already founding
  SELECT TRUE INTO v_already FROM public.profiles
    WHERE id = p_user_id AND founding_member = true;
  IF v_already THEN
    RETURN jsonb_build_object('ok', true, 'already_founding', true);
  END IF;

  -- Check quota availability (informational — we still record intent even if no slot)
  SELECT cap, claimed INTO v_cap, v_claimed FROM public.founding_quota WHERE locale = p_locale;
  v_remaining := COALESCE(v_cap, 0) - COALESCE(v_claimed, 0);

  INSERT INTO public.pending_founding_claims (user_id, locale, source, expires_at)
  VALUES (p_user_id, p_locale, p_source, now() + interval '24 hours')
  ON CONFLICT (user_id) DO UPDATE
    SET locale     = EXCLUDED.locale,
        source     = EXCLUDED.source,
        expires_at = EXCLUDED.expires_at,
        created_at = LEAST(public.pending_founding_claims.created_at, EXCLUDED.created_at);

  RETURN jsonb_build_object(
    'ok',         true,
    'locale',     p_locale,
    'remaining',  v_remaining,
    'cap',        v_cap,
    'claimed',    v_claimed
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ensure_pending_founding_claim(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.ensure_pending_founding_claim(uuid, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- C) resolve_payment_price — single source of truth for current price
-- ---------------------------------------------------------------------------
-- Called by yookassa-create-payment AND bot._send_stars_invoice.
-- Returns:
--   amount_rub        — Yookassa amount (1500 or 1050)
--   amount_stars      — Stars amount   (956  or  669)
--   founding_intent   — true if user should be charged founding price AND should
--                       be claimed as founding upon successful payment
--   locale            — 'ru' | 'en' | null (locale of the founding claim, or null)
--
-- Logic:
--   1. If profiles.founding_member = true       → founding price, no intent
--      (already founding — they always pay discount, no new slot to claim)
--   2. ELSE IF pending_founding_claims active   → founding price, intent = true
--      (will trigger claim_founding_slot in webhook/Stars success)
--   3. ELSE                                     → standard price, no intent

CREATE OR REPLACE FUNCTION public.resolve_payment_price(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_is_founding boolean;
  v_user_lang   text;
  v_claim_locale text;
  v_claim_active boolean;
  v_quota_remaining int;
  v_amount_rub  int;
  v_amount_stars int;
  v_locale      text;
  v_intent      boolean := false;
BEGIN
  -- Standard prices (constants live here, not scattered across edge functions)
  v_amount_rub   := 1500;
  v_amount_stars := 956;
  v_locale       := null;

  -- 1. Already founding? → discount, no new claim
  SELECT founding_member, COALESCE(founding_locale, lang)
    INTO v_is_founding, v_user_lang
  FROM public.profiles WHERE id = p_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'profile_not_found',
      'amount_rub', v_amount_rub, 'amount_stars', v_amount_stars,
      'founding_intent', false
    );
  END IF;

  IF v_is_founding THEN
    RETURN jsonb_build_object(
      'ok', true,
      'amount_rub',      1050,
      'amount_stars',    669,
      'founding_intent', false,
      'already_founding', true,
      'locale',          v_user_lang
    );
  END IF;

  -- 2. Active pending claim?
  SELECT locale, (expires_at > now())
    INTO v_claim_locale, v_claim_active
  FROM public.pending_founding_claims WHERE user_id = p_user_id;

  IF v_claim_active THEN
    -- Verify there's still a slot in that locale (defensive — webhook double-checks)
    SELECT cap - claimed INTO v_quota_remaining FROM public.founding_quota WHERE locale = v_claim_locale;
    IF COALESCE(v_quota_remaining, 0) > 0 THEN
      v_amount_rub   := 1050;
      v_amount_stars := 669;
      v_locale       := v_claim_locale;
      v_intent       := true;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok',              true,
    'amount_rub',      v_amount_rub,
    'amount_stars',    v_amount_stars,
    'founding_intent', v_intent,
    'already_founding', false,
    'locale',          v_locale
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_payment_price(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.resolve_payment_price(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- D) Fix apply_stars_payment — respect trial_end (parity with YooKassa path)
-- ---------------------------------------------------------------------------
-- Previously: v_new := greatest(coalesce(v_current, now()), now()) + 30d
-- Bug: ignored profiles.trial_end → Stars-paying users during trial lost
--      remaining trial days.
-- Now: v_base accounts for trial_end as well, then +30d, but never less than
--      Telegram's authoritative subscription_expiration_date when provided.

CREATE OR REPLACE FUNCTION public.apply_stars_payment(
  p_telegram_charge_id text,
  p_user_id uuid,
  p_amount_stars integer,
  p_subscription_expiration_date timestamp with time zone,
  p_paid_at timestamp with time zone,
  p_raw jsonb,
  p_is_recurring boolean
)
RETURNS timestamp with time zone
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_current        timestamptz;
  v_trial_end      timestamptz;
  v_base           timestamptz;
  v_new            timestamptz;
  v_existing_sub_id uuid;
BEGIN
  -- 1. Идемпотентная запись платежа
  INSERT INTO public.payments (
    user_id, provider, provider_payment_id, amount, currency, status,
    plan, period_months, description, is_test, paid_at, raw_event, created_at,
    is_recurring
  ) VALUES (
    p_user_id, 'telegram_stars', p_telegram_charge_id, p_amount_stars, 'XTR', 'succeeded',
    'month', 1, 'BelFed subscription (Stars)', false, p_paid_at, p_raw, now(),
    p_is_recurring
  )
  ON CONFLICT (provider, provider_payment_id) DO UPDATE
     SET status    = 'succeeded',
         paid_at   = EXCLUDED.paid_at,
         raw_event = EXCLUDED.raw_event;

  -- 2. Берём оба окончания: текущая подписка И trial.
  --    Это симметрично с apply_successful_payment (YooKassa).
  SELECT subscription_expires_at, trial_end INTO v_current, v_trial_end
  FROM public.profiles WHERE id = p_user_id FOR UPDATE;

  v_base := GREATEST(
    COALESCE(v_current,   now()),
    COALESCE(v_trial_end, now()),
    now()
  );

  -- Наша внутренняя дата = v_base + 30d (для расчёта доступа в системе).
  -- Если Telegram прислал свою дату — берём максимум: пользователь не должен
  -- потерять trial-дни из-за того, что Telegram отсчитывает биллинг от момента
  -- оплаты, а не от конца триала.
  v_new := v_base + interval '30 days';
  IF p_subscription_expiration_date IS NOT NULL THEN
    v_new := GREATEST(v_new, p_subscription_expiration_date);
  END IF;

  -- 3. Профиль
  UPDATE public.profiles
     SET subscription_status     = 'active',
         subscription_expires_at = v_new,
         subscription_plan       = 'month',
         updated_at              = now()
   WHERE id = p_user_id;

  -- 4. Subscriptions
  SELECT id INTO v_existing_sub_id
  FROM public.subscriptions
  WHERE user_id = p_user_id
    AND status IN ('active','trialing','past_due')
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_existing_sub_id IS NOT NULL THEN
    UPDATE public.subscriptions
       SET plan_code                = 'month',
           provider                 = 'telegram_stars',
           provider_subscription_id = p_telegram_charge_id,
           status                   = 'active',
           current_period_end       = v_new,
           cancel_at_period_end     = false,
           next_billing_at          = CASE WHEN p_is_recurring THEN v_new ELSE NULL END,
           amount_stars             = p_amount_stars,
           failed_attempts          = 0,
           last_charge_error        = NULL,
           last_charge_attempt_at   = now(),
           cancel_reason            = NULL,
           updated_at               = now()
     WHERE id = v_existing_sub_id;
  ELSE
    INSERT INTO public.subscriptions (
      user_id, plan_code, provider, provider_subscription_id,
      status, current_period_end, cancel_at_period_end,
      next_billing_at, amount_stars, failed_attempts
    ) VALUES (
      p_user_id, 'month', 'telegram_stars', p_telegram_charge_id,
      'active', v_new, false,
      CASE WHEN p_is_recurring THEN v_new ELSE NULL END,
      p_amount_stars, 0
    );
  END IF;

  RETURN v_new;
END;
$function$;

-- Re-apply grants (CREATE OR REPLACE preserves them, but defensive)
REVOKE ALL ON FUNCTION public.apply_stars_payment(text, uuid, integer, timestamptz, timestamptz, jsonb, boolean) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.apply_stars_payment(text, uuid, integer, timestamptz, timestamptz, jsonb, boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- E) founding_pricing_config — public read-only view of current prices
-- ---------------------------------------------------------------------------
-- For admin UI / marketing pages: one place to fetch authoritative prices.
-- Hardcoded for now (matches resolve_payment_price). Future: move to a config
-- table if we want to change prices without migration.

CREATE OR REPLACE VIEW public.founding_pricing_config AS
SELECT
  1500 AS standard_rub,
  1050 AS founding_rub,
  956  AS standard_stars,
  669  AS founding_stars,
  30   AS discount_pct;

ALTER VIEW public.founding_pricing_config SET (security_invoker = on);
GRANT SELECT ON public.founding_pricing_config TO anon, authenticated, service_role;

COMMIT;

-- ---------------------------------------------------------------------------
-- Smoke test (run separately, NOT in this transaction):
-- ---------------------------------------------------------------------------
-- select public.resolve_payment_price('668a5d3e-8315-450c-b738-805f660d6fa6');
-- -- expect: {amount_rub:1500, amount_stars:956, founding_intent:false}
--
-- select public.ensure_pending_founding_claim(
--   '668a5d3e-8315-450c-b738-805f660d6fa6'::uuid, 'ru', 'test_smoke');
-- select public.resolve_payment_price('668a5d3e-8315-450c-b738-805f660d6fa6');
-- -- expect: {amount_rub:1050, amount_stars:669, founding_intent:true, locale:'ru'}
--
-- delete from public.pending_founding_claims
--   where user_id='668a5d3e-8315-450c-b738-805f660d6fa6';

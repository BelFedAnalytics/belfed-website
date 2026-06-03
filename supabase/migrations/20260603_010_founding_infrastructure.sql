-- Founding Members infrastructure.
-- Programme: первые 50 RU + 50 EN получают -30% пожизненно (1040 ₽ vs 1490 ₽),
-- ×3 chart-quota за 24 часа, 60-дневное grace окно для реактивации.

-- =====================================================================
-- 1. Поля в profiles
-- =====================================================================
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS founding_member       boolean      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS founding_member_since timestamptz,
  ADD COLUMN IF NOT EXISTS founding_locale       text,
  ADD COLUMN IF NOT EXISTS founding_grace_until  timestamptz;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_founding_locale_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_founding_locale_check CHECK (founding_locale IS NULL OR founding_locale IN ('ru','en'));

CREATE INDEX IF NOT EXISTS idx_profiles_founding_member ON public.profiles(founding_member) WHERE founding_member = true;

-- =====================================================================
-- 2. Квота: 50 RU + 50 EN
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.founding_quota (
  locale     text PRIMARY KEY CHECK (locale IN ('ru','en')),
  cap        int  NOT NULL CHECK (cap > 0),
  claimed    int  NOT NULL DEFAULT 0 CHECK (claimed >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.founding_quota (locale, cap) VALUES ('ru', 50), ('en', 50)
  ON CONFLICT (locale) DO NOTHING;

ALTER TABLE public.founding_quota ENABLE ROW LEVEL SECURITY;

-- SELECT публичный — фронт показывает "X из 50 мест" на pricing page
DROP POLICY IF EXISTS founding_quota_select_all ON public.founding_quota;
CREATE POLICY founding_quota_select_all ON public.founding_quota FOR SELECT USING (true);
-- UPDATE/INSERT/DELETE только service_role (RLS блокирует anon/authenticated, bypassed by service_role)

GRANT SELECT ON public.founding_quota TO anon, authenticated;

-- =====================================================================
-- 3. Audit-таблица выдачи статусов
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.founding_members_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  locale      text NOT NULL CHECK (locale IN ('ru','en')),
  slot_number int  NOT NULL CHECK (slot_number > 0),
  source      text NOT NULL,                              -- 'dm_outreach' | 'public_post' | 'manual_grant' | 'webhook'
  granted_at  timestamptz NOT NULL DEFAULT now(),
  granted_by  uuid REFERENCES auth.users(id),
  notes       text,
  UNIQUE (locale, slot_number),
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_founding_log_locale ON public.founding_members_log(locale);
CREATE INDEX IF NOT EXISTS idx_founding_log_user ON public.founding_members_log(user_id);

ALTER TABLE public.founding_members_log ENABLE ROW LEVEL SECURITY;
-- Только админы через RPC
REVOKE ALL ON public.founding_members_log FROM anon, authenticated;

-- =====================================================================
-- 4. Атомарная выдача founding-slot
-- =====================================================================
CREATE OR REPLACE FUNCTION public.claim_founding_slot(
  p_user_id uuid,
  p_locale  text,
  p_source  text DEFAULT 'webhook',
  p_notes   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'auth'
AS $$
DECLARE
  v_cap      int;
  v_claimed  int;
  v_already  boolean;
  v_slot     int;
BEGIN
  IF p_locale NOT IN ('ru','en') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_locale');
  END IF;

  -- Уже выдан?
  SELECT TRUE INTO v_already FROM public.profiles WHERE id = p_user_id AND founding_member = true;
  IF v_already THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_founding');
  END IF;

  -- FOR UPDATE — атомарный захват слота
  SELECT cap, claimed INTO v_cap, v_claimed
    FROM public.founding_quota WHERE locale = p_locale FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'quota_not_configured');
  END IF;

  IF v_claimed >= v_cap THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'quota_exhausted',
      'cap', v_cap, 'claimed', v_claimed);
  END IF;

  v_slot := v_claimed + 1;

  UPDATE public.founding_quota
     SET claimed = v_slot, updated_at = now()
   WHERE locale = p_locale;

  UPDATE public.profiles
     SET founding_member       = true,
         founding_member_since = now(),
         founding_locale       = p_locale,
         updated_at            = now()
   WHERE id = p_user_id;

  INSERT INTO public.founding_members_log (user_id, locale, slot_number, source, granted_by, notes)
  VALUES (p_user_id, p_locale, v_slot, p_source, auth.uid(), p_notes);

  RETURN jsonb_build_object('ok', true, 'locale', p_locale, 'slot', v_slot, 'cap', v_cap);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_founding_slot(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
-- Только service_role (webhook) — authenticated не нужен напрямую

-- =====================================================================
-- 5. Лимит chart-запросов: 3/24h для founding, 1/24h для остальных
-- =====================================================================
CREATE OR REPLACE FUNCTION public.user_daily_chart_quota(uid uuid)
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
  SELECT CASE
    WHEN EXISTS(SELECT 1 FROM public.profiles WHERE id = uid AND founding_member = true) THEN 3
    ELSE 1
  END;
$$;

GRANT EXECUTE ON FUNCTION public.user_daily_chart_quota(uuid) TO authenticated;

-- =====================================================================
-- 6. Триггер: пересчёт квоты при изменении profiles.founding_member
-- (защита от рассинхрона при ручной правке через admin RPC)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.tg_resync_founding_quota()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  -- Пересчитываем claimed по фактическому количеству активных founding members на локаль
  UPDATE public.founding_quota fq
     SET claimed = (
           SELECT COUNT(*) FROM public.profiles p
           WHERE p.founding_member = true AND p.founding_locale = fq.locale
         ),
         updated_at = now();
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_resync_founding_quota ON public.profiles;
CREATE TRIGGER trg_resync_founding_quota
AFTER INSERT OR UPDATE OF founding_member, founding_locale OR DELETE ON public.profiles
FOR EACH STATEMENT
EXECUTE FUNCTION public.tg_resync_founding_quota();

-- =====================================================================
-- 7. Admin RPC для ручной выдачи / снятия (для уже существующих юзеров)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.admin_grant_founding(
  p_user_id uuid,
  p_locale  text,
  p_extend_days int DEFAULT 13,
  p_notes   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'auth'
AS $$
DECLARE
  v_claim_result jsonb;
  v_sub_id uuid;
  v_old_end timestamptz;
  v_new_end timestamptz;
BEGIN
  IF NOT public.is_admin_user(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  v_claim_result := public.claim_founding_slot(p_user_id, p_locale, 'manual_grant', p_notes);

  IF NOT (v_claim_result->>'ok')::boolean THEN
    RETURN v_claim_result;
  END IF;

  IF p_extend_days IS NOT NULL AND p_extend_days > 0 THEN
    SELECT id, current_period_end INTO v_sub_id, v_old_end
      FROM public.subscriptions
     WHERE user_id = p_user_id AND status IN ('active','trialing')
     ORDER BY updated_at DESC NULLS LAST LIMIT 1;

    IF FOUND THEN
      v_new_end := COALESCE(v_old_end, now()) + (p_extend_days || ' days')::interval;
      UPDATE public.subscriptions
         SET current_period_end = v_new_end,
             next_billing_at    = v_new_end,
             updated_at = now()
       WHERE id = v_sub_id;

      -- зеркалируем в profiles чтобы старая модель доступа тоже отражала
      UPDATE public.profiles
         SET subscription_expires_at = GREATEST(COALESCE(subscription_expires_at, v_new_end), v_new_end),
             updated_at = now()
       WHERE id = p_user_id;
    END IF;
  END IF;

  RETURN v_claim_result || jsonb_build_object('extended_days', p_extend_days, 'new_period_end', v_new_end);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_grant_founding(uuid, text, int, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_grant_founding(uuid, text, int, text) TO authenticated;

-- =====================================================================
-- 8. Обновляем admin_subscribers_v1 — добавляем founding-поля
-- =====================================================================
CREATE OR REPLACE VIEW public.admin_subscribers_v1
WITH (security_invoker = true)
AS
 SELECT p.id,
    p.email,
    p.telegram_id,
    p.telegram_username,
    p.lang,
    p.subscription_status,
    p.subscription_plan,
    p.subscription_expires_at,
    p.trial_start,
    p.trial_end,
    p.trial_source,
    p.is_lite_profile,
    p.is_test_profile,
    p.admin_notes,
    p.created_at,
    p.updated_at,
    p.founding_member,
    p.founding_locale,
    p.founding_member_since,
    p.founding_grace_until,
    fl.slot_number AS founding_slot,
    u.last_sign_in_at,
    s.cancel_at_period_end,
    s.next_billing_at,
    s.status AS sub_status,
    s.failed_attempts,
    s.current_period_end,
    s.provider AS sub_provider,
    s.amount_rub,
    s.amount_stars,
    pay_last.paid_at AS last_payment_at,
    pay_last.amount AS last_payment_amount,
    pay_last.currency AS last_payment_currency,
    pay_last.provider AS last_payment_provider,
    pay_agg.total_payments_count,
    pay_agg.total_rub_paid,
    pay_agg.total_stars_paid,
    inv.invites_count,
    inv.last_invite_at
   FROM public.profiles p
     LEFT JOIN auth.users u ON u.id = p.id
     LEFT JOIN public.founding_members_log fl ON fl.user_id = p.id
     LEFT JOIN LATERAL (
       SELECT * FROM public.subscriptions
       WHERE user_id = p.id
       ORDER BY updated_at DESC NULLS LAST LIMIT 1
     ) s ON true
     LEFT JOIN LATERAL (
       SELECT * FROM public.payments
       WHERE user_id = p.id AND status = 'succeeded'
       ORDER BY paid_at DESC LIMIT 1
     ) pay_last ON true
     LEFT JOIN LATERAL (
       SELECT count(*) FILTER (WHERE status = 'succeeded') AS total_payments_count,
              sum(amount) FILTER (WHERE status = 'succeeded' AND currency = 'RUB') AS total_rub_paid,
              sum(amount) FILTER (WHERE status = 'succeeded' AND currency IN ('XTR','STARS')) AS total_stars_paid
       FROM public.payments WHERE user_id = p.id
     ) pay_agg ON true
     LEFT JOIN LATERAL (
       SELECT count(*) AS invites_count, max(created_at) AS last_invite_at
       FROM public.telegram_access_log WHERE user_id = p.id
     ) inv ON true;

-- =====================================================================
-- 9. View публичной квоты для фронта
-- =====================================================================
CREATE OR REPLACE VIEW public.founding_quota_public
WITH (security_invoker = true)
AS
SELECT locale, cap, claimed, GREATEST(cap - claimed, 0) AS remaining FROM public.founding_quota;

GRANT SELECT ON public.founding_quota_public TO anon, authenticated;

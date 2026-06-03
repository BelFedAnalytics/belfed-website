-- Track when we've sent founding-renewal reminder to avoid duplicates.
-- Reset to NULL by tg_reset_founding_reminder_on_renew (migration 014) on successful renewal.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS founding_renewal_reminder_sent_at timestamptz;

-- View: founding members whose subscription expires in 2-5 days and we haven't reminded yet.
-- Window 2-5 days = cron runs daily, gives one nudge ~3-4 days out, idempotent via founding_renewal_reminder_sent_at.
CREATE OR REPLACE VIEW public.users_for_founding_renewal_reminder AS
SELECT
  p.id              AS user_id,
  p.telegram_id     AS telegram_id,
  p.founding_locale AS locale,
  s.current_period_end,
  s.id              AS subscription_id,
  s.payment_method_id
FROM public.profiles p
JOIN public.subscriptions s ON s.user_id = p.id
WHERE p.founding_member = true
  AND p.telegram_id IS NOT NULL
  AND s.status IN ('active','past_due')
  AND s.current_period_end IS NOT NULL
  AND s.current_period_end >= now() + interval '2 days'
  AND s.current_period_end <  now() + interval '5 days'
  AND p.founding_renewal_reminder_sent_at IS NULL;

GRANT SELECT ON public.users_for_founding_renewal_reminder TO service_role;

COMMENT ON COLUMN public.profiles.founding_renewal_reminder_sent_at IS
  'Set by telegram-founding-renewal-reminder cron when we send the pre-renewal DM. Reset to NULL after successful auto-renewal to allow next-cycle reminder.';

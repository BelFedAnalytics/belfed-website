-- Add provider + provider_subscription_id to the renewal-reminder view so the edge
-- function can detect "auto-renewal exists" for Telegram Stars subscriptions
-- (which don't use payment_method_id — auto-renewal is handled by Telegram itself).
CREATE OR REPLACE VIEW public.users_for_founding_renewal_reminder AS
SELECT
  p.id              AS user_id,
  p.telegram_id     AS telegram_id,
  p.founding_locale AS locale,
  s.current_period_end,
  s.id              AS subscription_id,
  s.payment_method_id,
  s.provider,
  s.provider_subscription_id
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

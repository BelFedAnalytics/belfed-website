-- When a subscription's current_period_end moves forward (auto-renewal happened),
-- clear the founding_renewal_reminder_sent_at flag on the user's profile so that
-- the next billing cycle's reminder gets sent again.
--
-- Provider-agnostic: works for yookassa-webhook, yookassa-charge-recurring,
-- stars renewal, and any future channel that updates subscriptions.current_period_end.

CREATE OR REPLACE FUNCTION public.fn_reset_founding_reminder_on_renew()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.current_period_end IS DISTINCT FROM OLD.current_period_end
     AND NEW.current_period_end > COALESCE(OLD.current_period_end, 'epoch'::timestamptz) THEN
    UPDATE public.profiles
      SET founding_renewal_reminder_sent_at = NULL
    WHERE id = NEW.user_id
      AND founding_member = true
      AND founding_renewal_reminder_sent_at IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tg_reset_founding_reminder_on_renew ON public.subscriptions;
CREATE TRIGGER tg_reset_founding_reminder_on_renew
  AFTER UPDATE OF current_period_end ON public.subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_reset_founding_reminder_on_renew();

COMMENT ON FUNCTION public.fn_reset_founding_reminder_on_renew() IS
  'Resets founding_renewal_reminder_sent_at when subscription period rolls forward, enabling next-cycle reminder.';

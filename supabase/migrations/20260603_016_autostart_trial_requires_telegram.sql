-- 20260603_016_autostart_trial_requires_telegram.sql
--
-- Architectural invariant: a profile must NOT auto-start a trial unless
-- it has a telegram_id. This closes the gap where web signup (email+password
-- via belfed.com/auth.html) created an orphan profile with active trial but
-- no telegram_id — which left the user with no actual way to consume the
-- product (Telegram channels gate everything) and polluted the user base.
--
-- Behaviour after this change:
--   * profile row created via auth.users INSERT trigger (handle_new_user) →
--     stays with subscription_status = NULL, trial_* columns NULL.
--   * profile row created/updated by claim_trial_by_telegram RPC (which always
--     sets telegram_id before/together with the trial fields) → trial starts
--     normally because the trigger sees telegram_id IS NOT NULL.
--   * profile rows that are later UPDATE'd to attach telegram_id will NOT
--     auto-start a trial — claim_trial_by_telegram is the only path that
--     awards a trial, so the invariant holds end-to-end.
--
-- The web-side UX is handled separately: belfed-auth.js / auth.html show a
-- "Link Telegram to activate trial" screen after signUp, deep-linking to
-- @BelfedBot which calls bot-claim-trial → claim_trial_by_telegram.

CREATE OR REPLACE FUNCTION public.profiles_autostart_trial()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_days int;
  v_now  timestamptz := now();
  v_end  timestamptz;
BEGIN
  -- Invariant: only auto-start a trial when telegram_id is present.
  -- Web signup without TG → profile stays pending (subscription_status NULL,
  -- trial_* NULL). The frontend will then prompt the user to link Telegram.
  IF NEW.telegram_id IS NULL OR NEW.telegram_id = '' THEN
    RETURN NEW;
  END IF;

  v_days := COALESCE((SELECT value::int FROM public.config WHERE key = 'trial_days'), 14);
  v_end  := v_now + make_interval(days => v_days);

  IF NEW.trial_started_at IS NULL AND NEW.subscription_expires_at IS NULL THEN
    NEW.trial_started_at      := v_now;
    NEW.subscription_plan     := COALESCE(NEW.subscription_plan, 'trial');
    NEW.subscription_expires_at := v_end;
    IF NEW.trial_start IS NULL THEN NEW.trial_start := v_now; END IF;
    IF NEW.trial_end   IS NULL THEN NEW.trial_end   := v_end; END IF;
    IF NEW.subscription_status IS NULL THEN NEW.subscription_status := 'trial'; END IF;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.profiles_autostart_trial() IS
  'BEFORE INSERT/UPDATE on profiles. Auto-starts a 14-day trial ONLY when telegram_id is present. Web-only signups stay pending until Telegram is linked via bot-claim-trial.';

-- 20260701_022_web_signup_trial_provisioning.sql
--
-- ROOT CAUSE
-- Web signup (auth.users INSERT -> handle_new_user) creates a profile with
-- subscription_status = 'trial' (baseline default), but migration 016
-- (autostart_trial_requires_telegram) deliberately withheld trial_start/
-- trial_end unless telegram_id was present. The result was an INCOHERENT row:
--   subscription_status = 'trial'  AND  trial_end IS NULL
-- user_has_access() treats status='trial' with a NULL/past trial_end as NOT
-- entitled, so freshly-signed-up web users saw "TRIAL EXPIRED".
--
-- CONTEXT / WHY THIS SUPERSEDES 016 FOR TRIAL START
-- Migration 020 (2026-06-23, later than 016) shipped a full WEB member area
-- gated by user_has_access() (analysis_posts, analytics_reports,
-- active_positions, ...). A trial is therefore consumable on the website
-- without Telegram, so the 016 rationale ("no telegram => cannot consume the
-- product => don't grant a trial") no longer holds for the web funnel.
--
-- FIX (minimal, coherent)
--   1. profiles_autostart_trial(): on INSERT, provision a canonical 14-day
--      trial (trial_start, trial_end, subscription_expires_at, plan, status)
--      even when telegram_id is absent — so web signups are ACTIVE immediately.
--      A coherence guard also repairs any row that arrives as status='trial'
--      with a NULL trial_end. trial_started_at is set only when telegram_id is
--      present, preserving it as the "trial officially claimed" sentinel that
--      claim_trial_by_telegram() relies on (so the later web -> link-Telegram
--      flow still runs cleanly instead of returning 'trial_already_used').
--   2. One-off idempotent backfill of existing incoherent rows (the QA user and
--      any siblings): status='trial' AND trial_end IS NULL.
--
-- PRESERVED (unchanged): user_has_access(), expire_trials(), enforcement
-- (telegram-enforce-access / telegram_users_to_kick), staged trial reminders,
-- winback, Founding Member logic, and the canonical 14-day trial length.
-- A NULL trial_end never grants access — this migration removes NULL trial_end
-- for trial rows rather than loosening the entitlement rule.

begin;

create or replace function public.profiles_autostart_trial()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_days int;
  v_now  timestamptz := now();
  v_end  timestamptz;
begin
  v_days := coalesce((select value::int from public.config where key = 'trial_days'), 14);
  v_end  := v_now + make_interval(days => v_days);

  -- Only provision for pending/trial profiles — never touch active/admin/expired.
  if coalesce(new.subscription_status, 'trial') = 'trial'
     and new.trial_end is null
     and new.subscription_expires_at is null then
    new.subscription_plan       := coalesce(new.subscription_plan, 'trial');
    new.subscription_status     := 'trial';
    new.trial_start             := coalesce(new.trial_start, v_now);
    new.trial_end               := v_end;
    new.subscription_expires_at := v_end;
    -- trial_started_at is the "trial claimed" sentinel used by
    -- claim_trial_by_telegram(); set it only once Telegram is linked so the
    -- web -> link-Telegram flow is not short-circuited to 'trial_already_used'.
    if new.telegram_id is not null and new.telegram_id <> '' then
      new.trial_started_at := coalesce(new.trial_started_at, v_now);
    end if;
  end if;

  -- Coherence guard: a 'trial' row must never persist with a NULL trial_end.
  if new.subscription_status = 'trial' and new.trial_end is null then
    new.trial_start             := coalesce(new.trial_start, v_now);
    new.trial_end               := new.trial_start + make_interval(days => v_days);
    new.subscription_expires_at := coalesce(new.subscription_expires_at, new.trial_end);
    new.subscription_plan       := coalesce(new.subscription_plan, 'trial');
  end if;

  return new;
end;
$function$;

comment on function public.profiles_autostart_trial() is
  'BEFORE INSERT on profiles. Provisions a canonical 14-day trial for new pending/trial profiles (web signups included), keeping status/trial_end coherent. trial_started_at is stamped only when telegram_id is present, preserving the claim_trial_by_telegram sentinel.';

-- One-off backfill: repair existing incoherent rows (status='trial', trial_end NULL).
-- Trial window is derived from the profile's own trial_start/created_at, so rows
-- created long ago land in the past and are handled by the normal expire_trials
-- cron; recently-created rows (the QA account) get their full remaining window.
update public.profiles p
   set trial_start             = coalesce(p.trial_start, p.created_at, now()),
       trial_end               = coalesce(p.trial_start, p.created_at, now())
                                    + make_interval(days => coalesce((select value::int from public.config where key = 'trial_days'), 14)),
       subscription_expires_at = coalesce(
                                    p.subscription_expires_at,
                                    coalesce(p.trial_start, p.created_at, now())
                                      + make_interval(days => coalesce((select value::int from public.config where key = 'trial_days'), 14))),
       subscription_plan       = coalesce(p.subscription_plan, 'trial'),
       updated_at              = now()
 where p.subscription_status = 'trial'
   and p.trial_end is null;

commit;

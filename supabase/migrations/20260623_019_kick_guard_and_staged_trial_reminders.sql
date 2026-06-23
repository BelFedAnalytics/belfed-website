-- ==========================================================================
-- PR #19 — Auto-kick re-kick guard + staged trial reminders (−5/−3/−1 days)
-- Idempotent. Safe to re-run.
--
-- Fixes:
--   1. telegram_users_to_kick had no "already kicked" guard → the same expired
--      user was re-kicked and re-DM'd every 6h (one user kicked 58×). Now a user
--      is only listed if no SUCCESSFUL kick has been logged since their current
--      subscription_expires_at. Re-arms automatically if they resubscribe & lapse.
--   2. Trial reminders were single-stage ("tomorrow" only). Now staged at
--      trial_end − 5d / − 3d / − 1d, each idempotent via its own sent-at column,
--      keyed on trial_end for a 14-day trial.
--   3. start_trial now also writes trial_end/trial_start so the trial fields stay
--      consistent with subscription_expires_at (the autostart trigger already does).
-- ==========================================================================

-- ---- 1) Per-stage trial reminder columns -----------------------------------
alter table public.profiles
  add column if not exists trial_rem_d5_sent_at timestamptz,
  add column if not exists trial_rem_d3_sent_at timestamptz,
  add column if not exists trial_rem_d1_sent_at timestamptz;

comment on column public.profiles.trial_rem_d5_sent_at is
  'Set by trial-bot-reminders when the T-5d trial reminder DM is sent. Reset to NULL on (re)start of a trial.';
comment on column public.profiles.trial_rem_d3_sent_at is
  'Set by trial-bot-reminders when the T-3d trial reminder DM is sent.';
comment on column public.profiles.trial_rem_d1_sent_at is
  'Set by trial-bot-reminders when the T-1d trial reminder DM is sent.';

-- ---- 2) Re-kick guard: rebuild telegram_users_to_kick ----------------------
-- A user is eligible to be kicked only if:
--   * they have a telegram_id,
--   * subscription_expires_at passed by > 24h (grace), AND
--   * we have NOT already logged a successful kick on/after that expiry instant.
-- This stops the every-6h re-kick + re-DM loop, yet re-arms if the user
-- resubscribes (new, later subscription_expires_at) and lapses again.
create or replace view public.telegram_users_to_kick as
  select p.id            as user_id,
         p.telegram_id,
         p.subscription_expires_at
    from public.profiles p
   where p.telegram_id is not null
     and p.subscription_expires_at is not null
     and p.subscription_expires_at < now() - interval '24 hours'
     and not exists (
       select 1
         from public.telegram_access_log l
        where l.action = 'kick'
          and l.result = 'ok'
          and l.telegram_id = p.telegram_id::bigint
          and l.created_at >= p.subscription_expires_at
     );

alter view public.telegram_users_to_kick set (security_invoker = true);
revoke all on public.telegram_users_to_kick from anon, authenticated;
grant select on public.telegram_users_to_kick to service_role;

-- ---- 3) Staged trial-reminder view -----------------------------------------
-- Emits one row per trial user with the single stage that is currently due.
-- Stage thresholds are computed from trial_end. Each stage fires once because
-- of its dedicated *_sent_at guard. Windows are half-open so a daily cron
-- (and even a 6h cron) sends each stage exactly once.
--   T-5: trial_end within (now+4d , now+5d]  and d5 not sent
--   T-3: trial_end within (now+2d , now+3d]  and d3 not sent
--   T-1: trial_end within (now    , now+1d]  and d1 not sent
-- Status is checked as 'trial' (live status column) to avoid pinging expired users.
create or replace view public.users_for_trial_reminder_staged as
  with base as (
    select p.id as user_id,
           p.telegram_id,
           coalesce(nullif(p.lang,''),'ru') as lang,
           p.trial_end,
           p.trial_rem_d5_sent_at,
           p.trial_rem_d3_sent_at,
           p.trial_rem_d1_sent_at
      from public.profiles p
     where p.subscription_status = 'trial'
       and p.telegram_id is not null
       and p.telegram_id <> ''
       and p.trial_end is not null
       and p.trial_end > now()
  )
  select user_id, telegram_id, lang, trial_end, 5 as stage
    from base
   where trial_rem_d5_sent_at is null
     and trial_end >  now() + interval '4 days'
     and trial_end <= now() + interval '5 days'
  union all
  select user_id, telegram_id, lang, trial_end, 3 as stage
    from base
   where trial_rem_d3_sent_at is null
     and trial_end >  now() + interval '2 days'
     and trial_end <= now() + interval '3 days'
  union all
  select user_id, telegram_id, lang, trial_end, 1 as stage
    from base
   where trial_rem_d1_sent_at is null
     and trial_end >  now()
     and trial_end <= now() + interval '1 day';

alter view public.users_for_trial_reminder_staged set (security_invoker = true);
revoke all on public.users_for_trial_reminder_staged from anon, authenticated;
grant select on public.users_for_trial_reminder_staged to service_role;

-- ---- 4) Keep trial fields consistent in start_trial ------------------------
create or replace function public.start_trial(p_user uuid)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v_days     integer;
  v_until    timestamptz;
  v_existing timestamptz;
begin
  select coalesce((select value::int from public.config where key='trial_days'), 14) into v_days;

  select trial_started_at, subscription_expires_at into v_existing, v_until
    from public.profiles where id = p_user for update;

  if v_existing is not null then
    return v_until;
  end if;

  v_until := now() + make_interval(days => v_days);

  update public.profiles
     set trial_started_at        = now(),
         trial_start             = coalesce(trial_start, now()),
         trial_end               = v_until,
         subscription_plan       = 'trial',
         subscription_status     = coalesce(subscription_status, 'trial'),
         subscription_expires_at = v_until
   where id = p_user;

  return v_until;
end;
$$;
grant execute on function public.start_trial(uuid) to service_role, authenticated;

-- END PR #19

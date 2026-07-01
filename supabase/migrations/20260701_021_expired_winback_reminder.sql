-- ==========================================================================
-- PR #21 — Expired / paused win-back reminder (one-shot, dedup, re-arming)
-- Idempotent. Safe to re-run.
--
-- Adds the missing third reminder stage: a single win-back DM to users whose
-- access has lapsed (subscription expired / "paused"), who never became a
-- Founding Member, inviting them back on Founding-Member terms if seats remain.
--
-- Complements the existing flow:
--   * trial-bot-reminders  — pre-expiry nudges at trial_end −5/−3/−1 days.
--   * telegram-enforce-access — kicks users >24h past expiry (UNCHANGED here).
--   * this view             — post-lapse win-back, fired once per lapse.
--
-- Dedup + re-arm: fires only when winback_reminder_sent_at is NULL or predates
-- the current subscription_expires_at, so a user who resubscribes and lapses
-- again (new, later expiry) is re-armed for exactly one more win-back.
-- Does NOT touch enforcement and never shortens/advances any kick.
-- ==========================================================================

-- ---- 1) Dedup column -------------------------------------------------------
alter table public.profiles
  add column if not exists winback_reminder_sent_at timestamptz;

comment on column public.profiles.winback_reminder_sent_at is
  'Set by telegram-winback-reminder when the post-lapse win-back DM is sent. Re-arms automatically when a later subscription_expires_at (new lapse) appears.';

-- ---- 2) Win-back candidate view --------------------------------------------
-- A user is eligible for a win-back DM only if:
--   * they have a linked telegram_id,
--   * they are NOT already a Founding Member (nothing to win back / upsell),
--   * their live status is not active/admin (i.e. access has lapsed),
--   * their subscription_expires_at passed by > 1 day (after the trial T-1 DM
--     and aligned with the >24h enforcement grace) but within the last 30 days
--     (recent lapse only — do not nag long-churned users), AND
--   * no win-back has been sent since that expiry instant.
-- seats_remaining is surfaced so the edge function can pitch Founding-Member
-- terms while seats last, and fall back to a plain renewal when the 50 seats
-- for the user's locale are gone.
create or replace view public.users_for_expired_winback as
  select p.id                                                                   as user_id,
         p.telegram_id,
         coalesce(nullif(p.founding_locale,''), nullif(p.lang,''), 'ru')        as lang,
         p.subscription_expires_at,
         greatest(coalesce(q.cap - q.claimed, 0), 0)                            as seats_remaining
    from public.profiles p
    left join public.founding_quota q
      on q.locale = coalesce(nullif(p.founding_locale,''), nullif(p.lang,''), 'ru')
   where p.telegram_id is not null
     and p.telegram_id <> ''
     and p.founding_member = false
     and coalesce(p.subscription_status, '') not in ('active', 'admin')
     and p.subscription_expires_at is not null
     and p.subscription_expires_at < now() - interval '1 day'
     and p.subscription_expires_at > now() - interval '30 days'
     and (p.winback_reminder_sent_at is null
          or p.winback_reminder_sent_at < p.subscription_expires_at);

alter view public.users_for_expired_winback set (security_invoker = true);
revoke all on public.users_for_expired_winback from anon, authenticated;
grant select on public.users_for_expired_winback to service_role;

-- END PR #21

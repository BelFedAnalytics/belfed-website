-- 20260717_026_trial_activation_attempts.sql
--
-- Durable, privacy-conscious activation-attempt logging for the Telegram trial
-- claim flow (bot-claim-trial edge function).
--
-- Motivation: 2026-07-17 production incident — bot-claim-trial returned HTTP 500
-- (PGRST203 ambiguous function resolution) and there was no durable record of who
-- tried to activate and failed. The owner explicitly needs to identify Telegram
-- users who could not activate so they can be helped/re-contacted.
--
-- Privacy posture:
--   * telegram_id IS stored on purpose (owner needs to identify affected users).
--   * NO username, NO email, NO IP/UA — none of those are written here.
--   * error_code is a short, sanitized identifier (e.g. 'PGRST203', 'db_error',
--     'trial_already_used'); raw error bodies and secrets are never persisted.
--   * The edge function writes are best-effort and never block the claim.
--
-- Security posture (mirrors migration 20260603_001 for internal tables):
--   * RLS enabled with NO policies -> deny-all to anon/authenticated via PostgREST.
--   * All writes happen from edge functions under service_role, which bypasses RLS.
--   * Broad grants revoked from anon/authenticated as defense-in-depth.

create table if not exists public.trial_activation_attempts (
  id          uuid primary key default gen_random_uuid(),
  telegram_id bigint,
  user_id     uuid references auth.users(id) on delete set null,
  source      text,
  lang        text,
  phase       text not null check (phase in ('started','succeeded','failed')),
  error_code  text,
  created_at  timestamptz not null default now()
);

create index if not exists idx_taa_telegram on public.trial_activation_attempts(telegram_id);
create index if not exists idx_taa_created  on public.trial_activation_attempts(created_at);
create index if not exists idx_taa_phase    on public.trial_activation_attempts(phase);

-- Deny-all: enable RLS and add NO policies. Only service_role (which bypasses
-- RLS) can read/write, exactly as the edge functions do.
alter table public.trial_activation_attempts enable row level security;

revoke all on public.trial_activation_attempts from anon, authenticated;

comment on table public.trial_activation_attempts is
  'Best-effort activation-attempt audit for the Telegram trial claim flow. RLS-protected with no public policies (service_role only). Stores telegram_id so the owner can identify users who failed to activate; never stores username, email, IP/UA, secrets or raw error bodies. error_code is a sanitized identifier only.';

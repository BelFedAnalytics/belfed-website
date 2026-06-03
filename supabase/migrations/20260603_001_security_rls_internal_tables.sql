-- Phase 1: lock down 8 internal tables that should never be reached via PostgREST.
-- All access happens through edge functions running under service_role, which bypasses RLS.
-- Enable RLS where missing (deny-all by default), and revoke broad anon/authenticated grants
-- as defense-in-depth.

-- 1. Enable RLS on the 5 ERROR-level tables.
alter table public.sheet_sync_log enable row level security;
alter table public.feed_health_log enable row level security;
alter table public.subscription_events enable row level security;
alter table public.monitor_event_log enable row level security;
alter table public.leads_imports enable row level security;

-- 2. Belt + braces: revoke broad grants from anon and authenticated on all 8 tables.
-- service_role keeps its grants because Supabase manages those separately.
revoke all on public.sheet_sync_log from anon, authenticated;
revoke all on public.feed_health_log from anon, authenticated;
revoke all on public.subscription_events from anon, authenticated;
revoke all on public.monitor_event_log from anon, authenticated;
revoke all on public.leads_imports from anon, authenticated;
revoke all on public.auth_sessions from anon, authenticated;
revoke all on public.payment_events from anon, authenticated;
revoke all on public.trial_intents from anon, authenticated;

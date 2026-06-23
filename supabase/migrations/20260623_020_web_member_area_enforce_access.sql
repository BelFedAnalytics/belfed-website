-- 20260623_020_web_member_area_enforce_access.sql
--
-- PURPOSE
-- Make the web member area enforce the SAME access rule as the Telegram
-- auto-kick: a user whose trial ended WITHOUT a paid subscription must lose
-- access immediately, on every surface.
--
-- BACKGROUND
-- The web gate getEntitlement() in belfed-auth.js already denies expired
-- trials client-side, but client gating is bypassable with the public anon
-- key (see SUPABASE_EDGE_FUNCTIONS_GATING.md). Real enforcement = RLS.
--
-- Member-content tables (analysis_posts, analytics_reports,
-- analytics_sections, stock_analysis) already gate reads on the
-- expiry-aware user_has_access(auth.uid()), which returns false the moment
-- profiles.trial_end passes (for status='trial') or a subscription lapses.
--
-- The position tables (active_positions, partial_closes) were the gap: they
-- gated on the RAW status set ('active','trial','admin'), which does NOT
-- check trial_end. An expired trial who never paid could still read open
-- positions for up to ~1h, until the hourly expire-trials cron flipped their
-- status to 'expired'. This migration removes that window by switching both
-- policies to user_has_access(), so revocation is instant and consistent
-- with the channel kick.
--
-- user_has_access(uid) grants access when EITHER:
--   * a subscription row is active/trialing and not past current_period_end, OR
--   * profiles.subscription_status in ('admin','active'), OR
--   * profiles.subscription_status='trial' AND trial_end > now().
-- i.e. an expired trial with no paid subscription => false.

begin;

-- 1) active_positions: open / partially_closed positions for paying members
drop policy if exists subscribers_read_open on public.active_positions;
create policy subscribers_read_open
  on public.active_positions
  for select
  to authenticated
  using (
    status = any (array['open'::text, 'partially_closed'::text])
    and public.user_has_access(auth.uid())
  );

-- 2) partial_closes: partial-close history for paying members
drop policy if exists subscribers_read_partial_closes on public.partial_closes;
create policy subscribers_read_partial_closes
  on public.partial_closes
  for select
  to authenticated
  using (
    public.user_has_access(auth.uid())
  );

commit;

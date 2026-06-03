-- Phase 2: convert 4 internal views to security_invoker, revoke anon/authenticated grants.
-- These views are read only by edge functions under service_role.
alter view public.subscriptions_due_for_charge set (security_invoker = true);
alter view public.v_roster_gap                  set (security_invoker = true);
alter view public.users_for_trial_reminder      set (security_invoker = true);
alter view public.telegram_users_to_kick        set (security_invoker = true);

revoke all on public.subscriptions_due_for_charge from anon, authenticated;
revoke all on public.v_roster_gap                  from anon, authenticated;
revoke all on public.users_for_trial_reminder      from anon, authenticated;
revoke all on public.telegram_users_to_kick        from anon, authenticated;

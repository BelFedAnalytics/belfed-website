-- Phase 4: revoke EXECUTE from anon (and from authenticated where not needed) on internal
-- SECURITY DEFINER functions. Edge functions call these via service_role and are unaffected.
--
-- The 6 RPCs the frontend calls (user_has_access, user_is_admin, admin_roster_list,
-- admin_roster_summary, admin_roster_import_manual, admin_roster_manual_link) keep
-- EXECUTE for `authenticated` only — admin pages require an Auth session.

-- Step A: blanket revoke on every SECURITY DEFINER function in public schema, from both roles.
do $$
declare r record;
begin
  for r in
    select n.nspname as schema_name, p.proname as fn_name,
           pg_catalog.pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on p.pronamespace = n.oid
    where n.nspname = 'public'
      and p.prosecdef = true
  loop
    execute format('revoke all on function %I.%I(%s) from anon, authenticated, public',
                   r.schema_name, r.fn_name, r.args);
  end loop;
end$$;

-- Step B: restore EXECUTE for the 6 RPCs the frontend genuinely needs.
-- These are called from authenticated user sessions (admin pages, member pages).
grant execute on function public.user_has_access(uid uuid) to authenticated;
grant execute on function public.user_is_admin(uid uuid) to authenticated;
grant execute on function public.admin_roster_list() to authenticated;
grant execute on function public.admin_roster_summary() to authenticated;
grant execute on function public.admin_roster_import_manual(p_chat_id bigint, p_items jsonb) to authenticated;
grant execute on function public.admin_roster_manual_link(p_telegram_id bigint, p_email text) to authenticated;

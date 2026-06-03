-- Phase 3: pin search_path on 13 functions flagged with mutable search_path.
-- This prevents `search_path` hijacking attacks where an attacker creates a malicious
-- function in a schema earlier in the path than `public`.
alter function public.tg_set_updated_at()              set search_path = pg_catalog, public;
alter function public.set_updated_at_active_positions() set search_path = pg_catalog, public;
alter function public.handle_updated_at()              set search_path = pg_catalog, public;
alter function public.expire_trials()                  set search_path = pg_catalog, public;
alter function public.expire_subscriptions()           set search_path = pg_catalog, public;
alter function public.profiles_autoflag_test()         set search_path = pg_catalog, public;
alter function public.payments_autoflag_test()         set search_path = pg_catalog, public;
alter function public.touch_updated_at()               set search_path = pg_catalog, public;
alter function public.tg_analysis_posts_updated_at()   set search_path = pg_catalog, public;
alter function public.early_bonus_cutoff()             set search_path = pg_catalog, public;
alter function public.email_subscribers_touch()        set search_path = pg_catalog, public;
alter function public.handle_new_user()                set search_path = pg_catalog, public;
alter function public.set_initial_stop_price()         set search_path = pg_catalog, public;

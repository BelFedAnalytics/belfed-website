-- Integration test for 20260713_026_attribution_conversion.sql
-- =========================================================================
-- CANNOT run in the CI/dev sandbox here (no Postgres). Run against a scratch
-- Supabase DB AFTER applying the migration:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/sql/attribution_idempotency.test.sql
-- Wrapped in a rolled-back transaction so it leaves no residue.
-- =========================================================================
BEGIN;

-- 1) record_conversion_event is idempotent on event_key ---------------------
SELECT public.record_conversion_event(
  'signup', 'trial-intent:__t_test__', NULL, 'anon-test', 'akey-test',
  '{"utm_source":"threads","utm_medium":"social"}'::jsonb, '/ru/');
SELECT public.record_conversion_event(
  'signup', 'trial-intent:__t_test__', NULL, 'anon-test', 'akey-test',
  '{"utm_source":"MUTATED"}'::jsonb, '/ru/');  -- replay: must DO NOTHING

DO $$
DECLARE n int; src text;
BEGIN
  SELECT count(*), max(utm_source) INTO n, src
  FROM public.conversion_attribution WHERE event_key = 'trial-intent:__t_test__';
  ASSERT n = 1, format('expected 1 signup row, got %s', n);
  ASSERT src = 'threads', format('replay must not mutate utm_source, got %s', src);
END $$;

-- 2) payment attribution inherits UTM from the latest signup/trial event ----
-- Use a throwaway profile id that exists; create a minimal signup event for it.
DO $$
DECLARE v_pid uuid;
BEGIN
  SELECT id INTO v_pid FROM public.profiles ORDER BY created_at LIMIT 1;
  IF v_pid IS NULL THEN RAISE NOTICE 'no profiles; skipping payment-inherit test'; RETURN; END IF;

  PERFORM public.record_conversion_event(
    'trial', 'trial-claim:__t_test__', v_pid, 'anon-test', 'akey-test',
    '{"utm_source":"threads","utm_campaign":"launch"}'::jsonb, '/ru/');

  PERFORM public.record_payment_attribution('yookassa', '__pay_test__', v_pid, 1500, 'RUB');
  PERFORM public.record_payment_attribution('yookassa', '__pay_test__', v_pid, 1500, 'RUB'); -- replay

  DECLARE n int; camp text;
  BEGIN
    SELECT count(*), max(utm_campaign) INTO n, camp
    FROM public.conversion_attribution WHERE event_key = 'yookassa:__pay_test__';
    ASSERT n = 1, format('expected 1 payment row, got %s', n);
    ASSERT camp = 'launch', format('payment must inherit utm_campaign, got %s', camp);
  END;
END $$;

-- 3) event_key NULL rows are allowed (index is partial) ---------------------
SELECT public.record_conversion_event('signup', NULL, NULL, 'anon-x', 'akey-x', '{}'::jsonb, NULL);
SELECT public.record_conversion_event('signup', NULL, NULL, 'anon-y', 'akey-y', '{}'::jsonb, NULL);
-- (both succeed; no assertion needed — a NOT NULL-only unique index permits these)

ROLLBACK;  -- leave no test residue

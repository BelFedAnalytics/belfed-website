-- Remove the 48h auto-expire behaviour for chart requests.
-- The admin wants to be able to answer chart requests regardless of age,
-- so pending requests should never silently flip to 'expired' anymore.

-- 1) Turn the expiry RPC into a permanent no-op (kept so any leftover
--    callers -- e.g. cached edge function versions -- don't error out).
CREATE OR REPLACE FUNCTION public.chart_requests_expire_old()
 RETURNS integer
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select 0;
$function$;

COMMENT ON FUNCTION public.chart_requests_expire_old() IS
  'Disabled 2026-08-24: auto-expiry after 48h removed per owner request. Admin can now respond to chart requests of any age. Kept as a no-op for backward compatibility with cached callers.';

-- 2) Restore previously auto-expired requests back into the live queue as
--    pending so the admin can act on them (owner-approved 2026-08-24).
UPDATE public.chart_requests
SET status = 'pending'
WHERE status = 'expired';

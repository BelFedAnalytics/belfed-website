-- Public, read-only metadata needed by the member dashboards to link each
-- currently open position to the Telegram message in which it was opened.
-- The function deliberately exposes no comments, payloads, user data, or
-- non-opening events.

CREATE OR REPLACE FUNCTION public.get_open_position_links()
RETURNS TABLE (
  asset_class text,
  ticker text,
  direction text,
  entry_price numeric,
  opened_at timestamptz,
  message_id_en bigint,
  message_id_ru bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    ap.asset_class,
    upper(ap.ticker) AS ticker,
    ap.direction,
    ap.entry_price,
    ap.opened_at,
    opened.message_id_en,
    opened.message_id_ru
  FROM public.active_positions ap
  JOIN LATERAL (
    SELECT pe.message_id_en, pe.message_id_ru
    FROM public.position_events pe
    WHERE pe.position_id = ap.id
      AND pe.event_type = 'opened'
      AND (pe.message_id_en IS NOT NULL OR pe.message_id_ru IS NOT NULL)
    ORDER BY pe.triggered_at ASC, pe.id ASC
    LIMIT 1
  ) opened ON true
  WHERE ap.status IN ('open', 'partial', 'partially_closed')
    AND ap.merged_into IS NULL;
$function$;

REVOKE ALL ON FUNCTION public.get_open_position_links() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_open_position_links() TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_open_position_links() IS
  'Whitelisted public metadata for member dashboards: open-position identity, opening date, and RU/EN Telegram message IDs only.';

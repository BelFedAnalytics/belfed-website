-- Review-card export: include public-idea positions that carry recorded history.
--
-- Problem: export_review_card_data() only returned closed, archived positions
-- with publish_to_en or publish_to_ru = true. Public swing ideas that were not
-- sent to the subscriber group (for example MU short 2026-09-26 -> 2026-11-25)
-- have both flags false, so their lifecycle never reached the card manifest and
-- the trade page showed the history-free fallback card.
--
-- Change: keep the existing flag condition and additionally accept a closed,
-- archived position that has real English narrative: a position or close
-- comment, a partial close with a comment, or an event with a subscriber
-- message id or a comment. Positions with no narrative at all (imported rows
-- without history) stay excluded, exactly as before.
--
-- Unchanged: token check, returned fields and shape, grants (CREATE OR REPLACE
-- keeps them). The client still whitelists fields and only attaches a card to a
-- row that matches a published table row by ticker, direction and both dates.
-- No accounting values are touched.
--
-- Rollback: re-apply the previous definition (the same function with the single
-- condition "(ap.publish_to_en = true or ap.publish_to_ru = true)").

create or replace function public.export_review_card_data(p_token text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare expected text;
begin
  select c.token_sha256 into expected from private.review_card_export_config c where c.singleton = true;
  if p_token is null or expected is null or encode(extensions.digest(p_token, 'sha256'), 'hex') <> expected then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  return (
    with p as (
      select ap.*
      from public.active_positions ap
      where ap.status = 'closed'
        and ap.archived_to_sheet_at is not null
        and (
          ap.publish_to_en = true
          or ap.publish_to_ru = true
          or nullif(btrim(ap.comment_en), '') is not null
          or nullif(btrim(ap.close_comment_en), '') is not null
          or exists (select 1 from public.partial_closes pc
                     where pc.position_id = ap.id and nullif(btrim(pc.comment_en), '') is not null)
          or exists (select 1 from public.position_events e
                     where e.position_id = ap.id
                       and (e.message_id_en is not null or nullif(btrim(e.payload->>'comment_en'), '') is not null))
        )
    )
    select jsonb_build_object(
      'generated_at', now(),
      'positions', coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'ticker',p.ticker,'asset_class',p.asset_class,'direction',p.direction,'status',p.status,'opened_at',p.opened_at,'closed_at',p.closed_at,'entry_price',p.entry_price,'exit_price',p.exit_price,'initial_stop_price',p.initial_stop_price,'stop_price',p.stop_price,'target_1',p.target_1,'target_2',p.target_2,'target_3',p.target_3,'result_rr',p.result_rr,'realized_r',p.realized_r,'remaining_pct',p.remaining_pct,'comment_en',p.comment_en,'comment_ru',p.comment_ru,'close_comment_en',p.close_comment_en,'close_comment_ru',p.close_comment_ru,'tradingview_url',p.tradingview_url,'sheet_row_id',p.sheet_row_id,'publish_to_en',p.publish_to_en,'publish_to_ru',p.publish_to_ru,'archived_to_sheet_at',p.archived_to_sheet_at) order by p.closed_at,p.id) from p),'[]'::jsonb),
      'events', coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'position_id',e.position_id,'event_type',e.event_type,'triggered_at',e.triggered_at,'triggered_price',e.triggered_price,'message_id_en',e.message_id_en,'message_id_ru',e.message_id_ru,'chart_url',coalesce(public.position_chart_media(e.id,null)->>'chart_url',e.chart_url),'chart_image_url',public.position_chart_media(e.id,null)->>'chart_image_url','payload',e.payload - 'text_ru' - 'text_en') order by e.triggered_at,e.id) from public.position_events e where e.position_id in (select id from p)),'[]'::jsonb),
      'partial_closes', coalesce((select jsonb_agg(jsonb_build_object('id',pc.id,'position_id',pc.position_id,'pct_closed',pc.pct_closed,'remaining_after',pc.remaining_after,'exit_price',pc.exit_price,'r_result',pc.r_result,'closed_at',pc.closed_at,'source',pc.source,'comment_en',pc.comment_en,'comment_ru',pc.comment_ru,'chart_url',coalesce(public.position_chart_media(null,pc.id)->>'chart_url',pc.chart_url),'chart_image_url',public.position_chart_media(null,pc.id)->>'chart_image_url') order by pc.closed_at,pc.id) from public.partial_closes pc where pc.position_id in (select id from p)),'[]'::jsonb)
    )
  );
end;
$function$;

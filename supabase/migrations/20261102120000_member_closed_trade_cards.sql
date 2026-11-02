-- Closed-trade ledger on the member dashboard: on-demand history cards.
-- member_position_history() keeps returning open positions plus trades closed
-- in the last 21 days. These two additive functions let the Scorecard ledger
-- match any closed trade and load its card only when a member opens it.

create or replace function public.member_closed_position_index()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
begin
  if auth.uid() is null or not public.user_has_access(auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',ap.id,'ticker',upper(ap.ticker),'asset_class',ap.asset_class,'direction',ap.direction,
      'status',ap.status,'opened_at',ap.opened_at,'closed_at',ap.closed_at,
      'has_history',(exists(select 1 from public.position_events e where e.position_id = ap.id and e.event_type <> 'edited')
                     or exists(select 1 from public.partial_closes pc where pc.position_id = ap.id)))
      order by ap.closed_at desc, ap.id)
    from public.active_positions ap
    where ap.merged_into is null and ap.status = 'closed'
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.member_position_card(p_id bigint)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
begin
  if auth.uid() is null or not public.user_has_access(auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object(
        'id',p.id,'ticker',upper(p.ticker),'asset_class',p.asset_class,'direction',p.direction,'status',p.status,
        'opened_at',p.opened_at,'closed_at',p.closed_at,'entry_price',p.entry_price,'exit_price',p.exit_price,
        'initial_stop_price',p.initial_stop_price,'stop_price',p.stop_price,
        'target_1',p.target_1,'target_2',p.target_2,'target_3',p.target_3,
        'result_rr',p.result_rr,'realized_r',p.realized_r,'remaining_pct',p.remaining_pct,
        'comment_en',p.comment_en,'comment_ru',p.comment_ru,'close_comment_en',p.close_comment_en,'close_comment_ru',p.close_comment_ru,
        'tradingview_url',p.tradingview_url,
        'events', coalesce((select jsonb_agg(jsonb_build_object(
            'id',e.id,'event_type',e.event_type,'triggered_at',e.triggered_at,'triggered_price',e.triggered_price,
            'message_id_en',e.message_id_en,'message_id_ru',e.message_id_ru,'chart_url',coalesce(public.position_chart_media(e.id,null)->>'chart_url',e.chart_url),'chart_image_url',public.position_chart_media(e.id,null)->>'chart_image_url',
            'is_addon',coalesce((e.payload->>'is_addon')::boolean,false),
            'reply_to_position_id',e.payload->'reply_to_position_id',
            'old_stop',e.payload->'old_stop','new_stop',e.payload->'new_stop',
            'partial_close_id',e.payload->'partial_close_id',
            'comment_en',e.payload->>'comment_en','comment_ru',e.payload->>'comment_ru',
            'text_en',e.payload->>'text_en','text_ru',e.payload->>'text_ru')
          order by e.triggered_at, e.id)
          from public.position_events e where e.position_id = p.id and e.event_type <> 'edited'), '[]'::jsonb),
        'partial_closes', coalesce((select jsonb_agg(jsonb_build_object(
            'id',pc.id,'pct_closed',pc.pct_closed,'remaining_after',pc.remaining_after,'exit_price',pc.exit_price,
            'r_result',pc.r_result,'closed_at',pc.closed_at,'comment_en',pc.comment_en,'comment_ru',pc.comment_ru,'chart_url',coalesce(public.position_chart_media(null,pc.id)->>'chart_url',pc.chart_url),'chart_image_url',public.position_chart_media(null,pc.id)->>'chart_image_url')
          order by pc.closed_at, pc.id)
          from public.partial_closes pc where pc.position_id = p.id), '[]'::jsonb)
      )
    from public.active_positions p
    where p.id = p_id and p.merged_into is null
  );
end;
$function$;

revoke all on function public.member_closed_position_index() from public, anon;
revoke all on function public.member_position_card(bigint) from public, anon;
grant execute on function public.member_closed_position_index() to authenticated, service_role;
grant execute on function public.member_position_card(bigint) to authenticated, service_role;

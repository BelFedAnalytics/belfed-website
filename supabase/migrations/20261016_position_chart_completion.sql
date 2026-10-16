-- Chart metadata is separate: UPDATE partial_closes would fire the R trigger.
create table if not exists public.position_chart_attachments (
  id uuid primary key default gen_random_uuid(),
  position_id bigint not null references public.active_positions(id),
  event_id bigint unique references public.position_events(id),
  partial_close_id bigint unique references public.partial_closes(id),
  chart_url text,
  image_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default clock_timestamp(),
  updated_by uuid references auth.users(id),
  check (event_id is not null or partial_close_id is not null),
  check (nullif(chart_url,'') is not null or nullif(image_path,'') is not null)
);
alter table public.position_chart_attachments enable row level security;
revoke all on public.position_chart_attachments from public, anon, authenticated;
grant all on public.position_chart_attachments to service_role;

create table if not exists public.position_chart_changes (
  id bigint generated always as identity primary key,
  attachment_id uuid not null references public.position_chart_attachments(id),
  changed_at timestamptz not null default now(),
  actor_id uuid,
  previous_value jsonb,
  new_value jsonb not null
);
alter table public.position_chart_changes enable row level security;
revoke all on public.position_chart_changes from public, anon, authenticated;
grant all on public.position_chart_changes to service_role;

create table if not exists public.position_chart_reminder_runs (
  day_msk date primary key,
  status text not null check (status in ('claimed','sent','silent','failed')),
  claimed_at timestamptz not null default now(),
  finished_at timestamptz,
  missing_count integer not null default 0,
  message_id bigint,
  error_code text
);
alter table public.position_chart_reminder_runs enable row level security;
revoke all on public.position_chart_reminder_runs from public, anon, authenticated;
grant all on public.position_chart_reminder_runs to service_role;

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('position-close-charts','position-close-charts',false,8388608,array['image/png','image/jpeg','image/webp'])
on conflict(id) do nothing;
-- No public Storage policies. Only service-role endpoints access this bucket.

create or replace function public.position_chart_media(p_event_id bigint, p_partial_id bigint)
returns jsonb language sql stable security definer set search_path=public
as $$
 select jsonb_build_object('chart_url',a.chart_url,
   'chart_image_url',case when a.image_path is not null then
   'https://obujqvqqmyfcfflhqvud.supabase.co/functions/v1/position-chart-media?id='||a.id::text end)
 from public.position_chart_attachments a
 where (p_event_id is not null and a.event_id=p_event_id)
    or (p_partial_id is not null and a.partial_close_id=p_partial_id)
 limit 1;
$$;
revoke all on function public.position_chart_media(bigint,bigint) from public,anon,authenticated;
grant execute on function public.position_chart_media(bigint,bigint) to service_role;

create or replace function public.position_chart_audit_data()
returns jsonb language sql stable security definer set search_path=public
as $$
 with p as (
  select id,ticker,direction,asset_class,status,opened_at,closed_at,exit_price,
         publish_to_ru,publish_to_en,archived_to_sheet_at,merged_into
  from public.active_positions
  where opened_at>='2026-09-01T00:00:00+03:00'::timestamptz
    and status<>'cancelled' and merged_into is null
 ), e as (
  select e.id,e.position_id,e.event_type,e.triggered_at,e.triggered_price,e.chart_url,e.chart_added_at,
         e.message_id_ru,e.message_id_en,e.email_sent_at,
         jsonb_build_object('partial_close_id',e.payload->'partial_close_id') as payload
  from public.position_events e join p on p.id=e.position_id
 ), c as (
  select c.id,c.position_id,c.closed_at,c.exit_price,c.pct_closed,c.remaining_after,
         c.chart_url,c.source,c.comment_en,c.comment_ru
  from public.partial_closes c join p on p.id=c.position_id
 )
 select jsonb_build_object(
 'positions',coalesce((select jsonb_agg(to_jsonb(p)) from p),'[]'::jsonb),
 'events',coalesce((select jsonb_agg(to_jsonb(e)) from e),'[]'::jsonb),
 'partials',coalesce((select jsonb_agg(to_jsonb(c)) from c),'[]'::jsonb),
 'attachments',coalesce((select jsonb_agg(to_jsonb(a)) from public.position_chart_attachments a join p on p.id=a.position_id),'[]'::jsonb));
$$;
revoke all on function public.position_chart_audit_data() from public,anon,authenticated;
grant execute on function public.position_chart_audit_data() to service_role;

create or replace function public.position_chart_save(
 p_position_id bigint,p_event_id bigint,p_partial_id bigint,p_chart_url text,
 p_image_path text,p_expected_updated_at timestamptz,p_actor uuid)
returns jsonb language plpgsql security definer set search_path=public
as $$
declare v public.position_chart_attachments; v_before jsonb;
begin
 if not exists(select 1 from public.profiles where id=p_actor and subscription_status='admin') then
   raise exception 'admin_required' using errcode='42501';
 end if;
 if p_event_id is null and p_partial_id is null then raise exception 'closure_required'; end if;
 if not exists(select 1 from public.active_positions where id=p_position_id
   and opened_at>='2026-09-01T00:00:00+03:00'::timestamptz and merged_into is null and status<>'cancelled') then
   raise exception 'position_out_of_scope';
 end if;
 if p_event_id is not null and not exists(select 1 from public.position_events where id=p_event_id
   and position_id=p_position_id and event_type in('closed','partial_closed','stop_hit','target_1_hit','target_2_hit','target_3_hit','partial_stop_1_hit','partial_stop_2_hit','partial_stop_3_hit')) then
   raise exception 'event_mismatch';
 end if;
 if p_partial_id is not null and not exists(select 1 from public.partial_closes where id=p_partial_id and position_id=p_position_id) then
   raise exception 'partial_mismatch';
 end if;
 perform pg_advisory_xact_lock(p_position_id);
 select * into v from public.position_chart_attachments
 where (p_event_id is not null and event_id=p_event_id) or (p_partial_id is not null and partial_close_id=p_partial_id)
 for update;
 if found then
   if v.updated_at is distinct from p_expected_updated_at then raise exception 'chart_conflict' using errcode='40001'; end if;
   v_before:=to_jsonb(v);
   update public.position_chart_attachments set
     event_id=coalesce(event_id,p_event_id),partial_close_id=coalesce(partial_close_id,p_partial_id),
     chart_url=nullif(p_chart_url,''),image_path=coalesce(p_image_path,image_path),
     updated_by=p_actor,updated_at=clock_timestamp()
   where id=v.id returning * into v;
 else
   if p_expected_updated_at is not null then raise exception 'chart_conflict' using errcode='40001'; end if;
   insert into public.position_chart_attachments(position_id,event_id,partial_close_id,chart_url,image_path,updated_by)
   values(p_position_id,p_event_id,p_partial_id,nullif(p_chart_url,''),p_image_path,p_actor) returning * into v;
 end if;
 insert into public.position_chart_changes(attachment_id,actor_id,previous_value,new_value)
 values(v.id,p_actor,v_before,to_jsonb(v));
 return to_jsonb(v);
end;
$$;
revoke all on function public.position_chart_save(bigint,bigint,bigint,text,text,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.position_chart_save(bigint,bigint,bigint,text,text,timestamptz,uuid) to service_role;

-- Enrich existing projections, preserving their original access controls and
-- field allowlists. Never rewrite position_events or partial_closes records.
do $$
declare f text; old text; new text; fn text; a text;
begin
 foreach fn in array array['member_position_history','export_review_card_data'] loop
  select pg_get_functiondef(oid) into f from pg_proc
   where pronamespace='public'::regnamespace and proname=fn;
  if f is null then raise exception 'Missing required projection %',fn; end if;
  if position('position_chart_media(' in f)>0 then continue; end if;
  foreach a in array array['e','pc'] loop
   old:=format('''chart_url'',%s.chart_url',a);
   new:=format('''chart_url'',coalesce(public.position_chart_media(%s)->>''chart_url'',%s.chart_url),''chart_image_url'',public.position_chart_media(%s)->>''chart_image_url''',
       case when a='e' then 'e.id,null' else 'null,pc.id' end,a,
       case when a='e' then 'e.id,null' else 'null,pc.id' end);
   if position(old in f)=0 then raise exception 'Unexpected projection format %.%',fn,a; end if;
   f:=replace(f,old,new);
  end loop;
  execute f;
 end loop;
end $$;

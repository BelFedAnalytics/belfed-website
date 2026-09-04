-- Independent Video Review publishing targets and localized delivery state.
begin;

alter table public.video_reviews
  add column if not exists publish_to_site_ru boolean not null default false,
  add column if not exists publish_to_site_en boolean not null default false,
  add column if not exists publish_to_telegram_ru boolean not null default false,
  add column if not exists publish_to_telegram_en boolean not null default false,
  add column if not exists published_at_ru timestamptz,
  add column if not exists published_at_en timestamptz,
  add column if not exists telegram_message_ru jsonb,
  add column if not exists telegram_message_en jsonb,
  add column if not exists telegram_send_started_at_ru timestamptz,
  add column if not exists telegram_send_started_at_en timestamptz,
  add column if not exists email_sent_at_ru timestamptz,
  add column if not exists email_sent_at_en timestamptz,
  add column if not exists email_send_started_at_ru timestamptz,
  add column if not exists email_send_started_at_en timestamptz;

-- Preserve behavior for any item published before this migration.
update public.video_reviews
set publish_to_site_ru = true,
    publish_to_site_en = true,
    published_at_ru = coalesce(published_at_ru, published_at),
    published_at_en = coalesce(published_at_en, published_at),
    email_sent_at_ru = coalesce(email_sent_at_ru, email_sent_at),
    email_sent_at_en = coalesce(email_sent_at_en, email_sent_at)
where status = 'published';

alter table public.video_reviews
  drop constraint if exists video_reviews_published_content_check;
alter table public.video_reviews
  add constraint video_reviews_published_content_check check (
    status <> 'published' or (
      (
        publish_to_site_ru or publish_to_site_en
        or publish_to_telegram_ru or publish_to_telegram_en
      )
      and (
        not (publish_to_site_ru or publish_to_telegram_ru)
        or (
          nullif(btrim(title_ru), '') is not null
          and nullif(btrim(video_url_ru), '') is not null
          and published_at_ru is not null
        )
      )
      and (
        not (publish_to_site_en or publish_to_telegram_en)
        or (
          nullif(btrim(title_en), '') is not null
          and nullif(btrim(video_url_en), '') is not null
          and published_at_en is not null
        )
      )
      and published_at is not null
    )
  );

drop policy if exists video_reviews_member_read on public.video_reviews;

create or replace function public.video_reviews_list(p_lang text)
returns table (
  id uuid,
  slug text,
  review_date date,
  sector text,
  duration_minutes integer,
  title text,
  summary text,
  video_url text,
  embed_url text,
  thumbnail_url text,
  related_content jsonb,
  published_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_lang is null or p_lang not in ('ru', 'en') then
    raise exception 'invalid language';
  end if;
  if auth.uid() is null or not public.user_has_access(auth.uid()) then
    raise exception 'access denied' using errcode = '42501';
  end if;

  return query
  select
    vr.id,
    vr.slug,
    vr.review_date,
    vr.sector,
    vr.duration_minutes,
    case when p_lang = 'ru' then vr.title_ru else vr.title_en end,
    case when p_lang = 'ru' then vr.summary_ru else vr.summary_en end,
    case when p_lang = 'ru' then vr.video_url_ru else vr.video_url_en end,
    case when p_lang = 'ru' then vr.embed_url_ru else vr.embed_url_en end,
    case when p_lang = 'ru' then vr.thumbnail_url_ru else vr.thumbnail_url_en end,
    case
      when p_lang = 'ru' then (
        select coalesce(jsonb_agg(jsonb_build_object(
          'label', item ->> 'label_ru',
          'url', item ->> 'url_ru'
        )), '[]'::jsonb)
        from jsonb_array_elements(coalesce(vr.related_content, '[]'::jsonb)) item
        where nullif(item ->> 'label_ru', '') is not null
          and nullif(item ->> 'url_ru', '') is not null
      )
      else (
        select coalesce(jsonb_agg(jsonb_build_object(
          'label', item ->> 'label_en',
          'url', item ->> 'url_en'
        )), '[]'::jsonb)
        from jsonb_array_elements(coalesce(vr.related_content, '[]'::jsonb)) item
        where nullif(item ->> 'label_en', '') is not null
          and nullif(item ->> 'url_en', '') is not null
      )
    end,
    case when p_lang = 'ru' then vr.published_at_ru else vr.published_at_en end
  from public.video_reviews vr
  where vr.status = 'published'
    and case
      when p_lang = 'ru' then vr.publish_to_site_ru
      else vr.publish_to_site_en
    end
  order by
    case when p_lang = 'ru' then vr.published_at_ru else vr.published_at_en end desc;
end;
$$;

revoke all on function public.video_reviews_list(text)
  from public, anon;
grant execute on function public.video_reviews_list(text)
  to authenticated;

create table if not exists public.video_review_telegram_attempts (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null,
  video_review_id uuid not null references public.video_reviews(id) on delete restrict,
  lang text not null check (lang in ('ru', 'en')),
  status text not null check (status in ('sending', 'sent', 'uncertain', 'failed', 'reconciled')),
  expected_updated_at timestamptz not null,
  payload jsonb not null,
  previous_state jsonb,
  telegram_result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operation_id, lang)
);

create unique index if not exists video_review_telegram_attempt_active_uniq
  on public.video_review_telegram_attempts (video_review_id, lang)
  where status in ('sending', 'uncertain');

alter table public.video_review_telegram_attempts enable row level security;
drop policy if exists video_review_telegram_attempts_admin_read
  on public.video_review_telegram_attempts;
create policy video_review_telegram_attempts_admin_read
  on public.video_review_telegram_attempts
  for select
  to authenticated
  using (public.user_is_admin(auth.uid()));

create or replace function public.claim_video_review_telegram_publish(
  p_review_id uuid,
  p_langs text[],
  p_expected_updated_at timestamptz,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_review public.video_reviews%rowtype;
  v_lang text;
  v_chat_id bigint;
  v_thread_id bigint;
  v_attempt_id uuid;
  v_snapshot jsonb;
  v_result jsonb := '{}'::jsonb;
begin
  if p_langs is null
     or cardinality(p_langs) < 1
     or cardinality(p_langs) > 2
     or exists (
       select 1 from unnest(p_langs) requested_lang
        where requested_lang is null or requested_lang not in ('ru', 'en')
     )
     or cardinality(array(select distinct x from unnest(p_langs) x)) <> cardinality(p_langs) then
    raise exception 'invalid languages';
  end if;
  if p_expected_updated_at is null or p_operation_id is null then
    raise exception 'expected version and operation ID are required';
  end if;

  select * into v_review
    from public.video_reviews
   where id = p_review_id
   for update;
  if not found then raise exception 'video review not found'; end if;
  if v_review.updated_at is distinct from p_expected_updated_at then
    raise exception 'video review version changed';
  end if;
  if v_review.status <> 'published' then
    raise exception 'video review is not published';
  end if;

  foreach v_lang in array p_langs loop
    if (v_lang = 'ru' and not v_review.publish_to_telegram_ru)
       or (v_lang = 'en' and not v_review.publish_to_telegram_en) then
      raise exception 'Telegram target % is disabled', v_lang;
    end if;
    if (v_lang = 'ru' and v_review.telegram_send_started_at_ru is not null)
       or (v_lang = 'en' and v_review.telegram_send_started_at_en is not null) then
      raise exception 'Telegram delivery % already has an active claim', v_lang;
    end if;
    if (v_lang = 'ru'
        and v_review.telegram_message_ru is not null
        and v_review.telegram_message_ru ->> 'status' <> 'sent')
       or (v_lang = 'en'
        and v_review.telegram_message_en is not null
        and v_review.telegram_message_en ->> 'status' <> 'sent') then
      raise exception 'Telegram delivery % requires reconciliation', v_lang;
    end if;

    select chat_id, thread_id
      into v_chat_id, v_thread_id
      from public.telegram_topics
     where topic_key = 'video_reviews'
       and lang = v_lang
       and is_active = true;
    if not found then
      raise exception 'active video_reviews Telegram route % is missing', v_lang;
    end if;

    v_snapshot := to_jsonb(v_review) || jsonb_build_object(
      'lang', v_lang,
      'topic_chat_id', v_chat_id,
      'topic_thread_id', v_thread_id,
      'previous_state', case
        when v_lang = 'ru' then v_review.telegram_message_ru
        else v_review.telegram_message_en
      end
    );

    insert into public.video_review_telegram_attempts
      (operation_id, video_review_id, lang, status, expected_updated_at, payload, previous_state)
    values
      (
        p_operation_id,
        p_review_id,
        v_lang,
        'sending',
        p_expected_updated_at,
        v_snapshot,
        case when v_lang = 'ru'
          then v_review.telegram_message_ru
          else v_review.telegram_message_en
        end
      )
    returning id into v_attempt_id;

    v_result := v_result || jsonb_build_object(
      v_lang,
      jsonb_build_object('attempt_id', v_attempt_id, 'snapshot', v_snapshot)
    );
  end loop;

  update public.video_reviews
     set telegram_send_started_at_ru = case
           when 'ru' = any(p_langs) then now()
           else telegram_send_started_at_ru
         end,
         telegram_send_started_at_en = case
           when 'en' = any(p_langs) then now()
           else telegram_send_started_at_en
         end
   where id = p_review_id;

  return v_result;
end;
$$;

revoke all on function public.claim_video_review_telegram_publish(uuid, text[], timestamptz, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_video_review_telegram_publish(uuid, text[], timestamptz, uuid)
  to service_role;

create or replace function public.finish_video_review_telegram_attempt(
  p_attempt_id uuid,
  p_status text,
  p_result jsonb default null,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_attempt public.video_review_telegram_attempts%rowtype;
  v_message jsonb;
begin
  if p_status not in ('sent', 'uncertain', 'failed') then
    raise exception 'invalid attempt status';
  end if;

  select * into v_attempt
    from public.video_review_telegram_attempts
   where id = p_attempt_id
   for update;
  if not found then raise exception 'Telegram attempt not found'; end if;
  if v_attempt.status <> 'sending' then
    raise exception 'Telegram attempt is not active';
  end if;

  if p_status = 'sent' then
    if p_result is null or nullif(p_result ->> 'message_id', '') is null then
      raise exception 'sent result requires message_id';
    end if;
    v_message := p_result || jsonb_build_object('status', 'sent');
  elsif p_status = 'uncertain' then
    v_message := coalesce(v_attempt.previous_state, '{}'::jsonb)
      || coalesce(p_result, '{}'::jsonb)
      || jsonb_build_object(
        'status', 'uncertain',
        'error', coalesce(p_error, 'ambiguous Telegram result'),
        'attempted_at', now(),
        'attempt_id', v_attempt.id
      );
  end if;

  if v_attempt.lang = 'ru' then
    update public.video_reviews
       set telegram_message_ru = case
             when p_status in ('sent', 'uncertain') then v_message
             else telegram_message_ru
           end,
           telegram_send_started_at_ru = case
             when p_status = 'uncertain' then telegram_send_started_at_ru
             else null
           end
     where id = v_attempt.video_review_id;
  else
    update public.video_reviews
       set telegram_message_en = case
             when p_status in ('sent', 'uncertain') then v_message
             else telegram_message_en
           end,
           telegram_send_started_at_en = case
             when p_status = 'uncertain' then telegram_send_started_at_en
             else null
           end
     where id = v_attempt.video_review_id;
  end if;

  update public.video_review_telegram_attempts
     set status = p_status,
         telegram_result = p_result,
         error = p_error,
         updated_at = now()
   where id = v_attempt.id;
  return true;
end;
$$;

revoke all on function public.finish_video_review_telegram_attempt(uuid, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.finish_video_review_telegram_attempt(uuid, text, jsonb, text)
  to service_role;

drop function if exists public.claim_video_review_telegram_send(uuid, text);

create or replace function public.claim_video_review_email_send(
  p_review_id uuid,
  p_lang text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_claimed integer;
begin
  if p_lang not in ('ru', 'en') then
    raise exception 'invalid language';
  end if;

  if p_lang = 'ru' then
    update public.video_reviews
       set email_send_started_at_ru = now()
     where id = p_review_id
       and status = 'published'
       and publish_to_site_ru = true
       and email_sent_at_ru is null
       and (
         email_send_started_at_ru is null
         or email_send_started_at_ru < now() - interval '30 minutes'
       );
  else
    update public.video_reviews
       set email_send_started_at_en = now()
     where id = p_review_id
       and status = 'published'
       and publish_to_site_en = true
       and email_sent_at_en is null
       and (
         email_send_started_at_en is null
         or email_send_started_at_en < now() - interval '30 minutes'
       );
  end if;

  get diagnostics v_claimed = row_count;
  return v_claimed = 1;
end;
$$;

revoke all on function public.claim_video_review_email_send(uuid, text)
  from public, anon, authenticated;
grant execute on function public.claim_video_review_email_send(uuid, text)
  to service_role;
drop function if exists public.claim_video_review_email_send(uuid);

create table if not exists public.video_review_telegram_reconciliations (
  id uuid primary key default gen_random_uuid(),
  video_review_id uuid not null references public.video_reviews(id) on delete restrict,
  attempt_id uuid references public.video_review_telegram_attempts(id) on delete restrict,
  lang text not null check (lang in ('ru', 'en')),
  resolution text not null check (resolution in ('confirmed_sent', 'confirmed_not_applied')),
  note text not null check (char_length(btrim(note)) between 3 and 1000),
  previous_state jsonb not null,
  resolved_state jsonb not null,
  resolved_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

alter table public.video_review_telegram_reconciliations enable row level security;
drop policy if exists video_review_telegram_reconciliations_admin_read
  on public.video_review_telegram_reconciliations;
create policy video_review_telegram_reconciliations_admin_read
  on public.video_review_telegram_reconciliations
  for select
  to authenticated
  using (public.user_is_admin(auth.uid()));

create or replace function public.reconcile_video_review_telegram(
  p_review_id uuid,
  p_lang text,
  p_resolution text,
  p_note text,
  p_message_id bigint default null,
  p_method text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_previous jsonb;
  v_resolved jsonb;
  v_current jsonb;
  v_started_at timestamptz;
  v_attempt public.video_review_telegram_attempts%rowtype;
  v_effective_message_id bigint;
  v_effective_method text;
begin
  if auth.uid() is null or not public.user_is_admin(auth.uid()) then
    raise exception 'access denied' using errcode = '42501';
  end if;
  if p_lang is null or p_lang not in ('ru', 'en') then
    raise exception 'invalid language';
  end if;
  if p_resolution is null
     or p_resolution not in ('confirmed_sent', 'confirmed_not_applied') then
    raise exception 'invalid resolution';
  end if;
  if p_note is null or char_length(btrim(p_note)) not between 3 and 1000 then
    raise exception 'reconciliation note must contain 3 to 1000 characters';
  end if;

  if p_lang = 'ru' then
    select telegram_message_ru, telegram_send_started_at_ru
      into v_current, v_started_at
      from public.video_reviews
     where id = p_review_id
     for update;
  else
    select telegram_message_en, telegram_send_started_at_en
      into v_current, v_started_at
      from public.video_reviews
     where id = p_review_id
     for update;
  end if;

  select * into v_attempt
    from public.video_review_telegram_attempts
   where video_review_id = p_review_id
     and lang = p_lang
     and status in ('sending', 'uncertain')
   order by created_at desc
   limit 1
   for update;

  if v_attempt.id is not null
     and v_attempt.status = 'sending'
     and v_attempt.created_at > now() - interval '15 minutes' then
    raise exception 'Telegram delivery is still running; reconciliation is available after 15 minutes';
  end if;
  if (v_current is null or coalesce(v_current ->> 'status', '') <> 'uncertain')
     and v_started_at is null
     and not found then
    raise exception 'only an uncertain or stranded Telegram delivery can be reconciled';
  end if;
  v_previous := coalesce(v_attempt.previous_state, v_current, '{}'::jsonb);
  v_effective_message_id := coalesce(
    p_message_id,
    nullif(v_current ->> 'message_id', '')::bigint,
    nullif(v_attempt.telegram_result ->> 'message_id', '')::bigint
  );
  v_effective_method := coalesce(
    p_method,
    nullif(v_current ->> 'method', ''),
    nullif(v_attempt.telegram_result ->> 'method', '')
  );
  if p_resolution = 'confirmed_sent'
     and v_effective_message_id is null then
    raise exception 'message_id is required when confirming a first delivery';
  end if;
  if p_message_id is not null and p_message_id <= 0 then
    raise exception 'invalid message_id';
  end if;
  if p_method is not null and p_method not in ('sendPhoto', 'sendMessage') then
    raise exception 'invalid Telegram method';
  end if;

  v_resolved := (
    coalesce(v_previous, '{}'::jsonb) || jsonb_build_object(
      'status', 'sent',
      'reconciliation', p_resolution,
      'reconciled_at', now(),
      'reconciled_by', auth.uid(),
      'reconciliation_note', btrim(p_note)
    )
  ) - 'error';
  if v_effective_message_id is not null then
    v_resolved := v_resolved || jsonb_build_object('message_id', v_effective_message_id);
  end if;
  if v_effective_method is not null then
    v_resolved := v_resolved || jsonb_build_object('method', v_effective_method);
  end if;

  if p_lang = 'ru' then
    update public.video_reviews
       set telegram_message_ru = v_resolved,
           telegram_send_started_at_ru = null
     where id = p_review_id;
  else
    update public.video_reviews
       set telegram_message_en = v_resolved,
           telegram_send_started_at_en = null
     where id = p_review_id;
  end if;

  if v_attempt.id is not null then
    update public.video_review_telegram_attempts
       set status = 'reconciled',
           error = null,
           telegram_result = v_resolved,
           updated_at = now()
     where id = v_attempt.id;
  end if;

  insert into public.video_review_telegram_reconciliations
    (video_review_id, attempt_id, lang, resolution, note, previous_state, resolved_state, resolved_by)
  values
    (p_review_id, v_attempt.id, p_lang, p_resolution, btrim(p_note), coalesce(v_previous, '{}'::jsonb), v_resolved, auth.uid());

  return v_resolved;
end;
$$;

revoke all on function public.reconcile_video_review_telegram(uuid, text, text, text, bigint, text)
  from public, anon;
grant execute on function public.reconcile_video_review_telegram(uuid, text, text, text, bigint, text)
  to authenticated;

create or replace function public.guard_video_review_delivery_history()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' then
    if old.telegram_message_ru is not null
       or old.telegram_message_en is not null
       or old.telegram_send_started_at_ru is not null
       or old.telegram_send_started_at_en is not null
       or old.email_sent_at_ru is not null
       or old.email_sent_at_en is not null
       or old.email_send_started_at_ru is not null
       or old.email_send_started_at_en is not null
       or exists (
         select 1 from public.email_sends es
          where es.video_review_id = old.id
       ) then
      raise exception 'video review with delivery history cannot be deleted; archive it instead';
    end if;
    return old;
  end if;

  if old.publish_to_telegram_ru
     and not new.publish_to_telegram_ru
     and (
       old.telegram_message_ru is not null
       or old.telegram_send_started_at_ru is not null
     ) then
    raise exception 'published Telegram RU target cannot be disabled; reconcile or archive';
  end if;
  if old.publish_to_telegram_en
     and not new.publish_to_telegram_en
     and (
       old.telegram_message_en is not null
       or old.telegram_send_started_at_en is not null
     ) then
    raise exception 'published Telegram EN target cannot be disabled; reconcile or archive';
  end if;
  if old.telegram_message_ru is not null and new.telegram_message_ru is null then
    raise exception 'Telegram RU delivery history cannot be erased';
  end if;
  if old.telegram_message_en is not null and new.telegram_message_en is null then
    raise exception 'Telegram EN delivery history cannot be erased';
  end if;
  if old.email_sent_at_ru is not null and new.email_sent_at_ru is null then
    raise exception 'email RU delivery history cannot be erased';
  end if;
  if old.email_sent_at_en is not null and new.email_sent_at_en is null then
    raise exception 'email EN delivery history cannot be erased';
  end if;
  if (
       old.telegram_send_started_at_ru is not null
       or old.telegram_send_started_at_en is not null
       or old.email_send_started_at_ru is not null
       or old.email_send_started_at_en is not null
     )
     and (
       to_jsonb(old) - array[
         'updated_at',
         'telegram_message_ru', 'telegram_message_en',
         'telegram_send_started_at_ru', 'telegram_send_started_at_en',
         'email_sent_at', 'email_sent_at_ru', 'email_sent_at_en',
         'email_send_started_at_ru', 'email_send_started_at_en'
       ]
       is distinct from
       to_jsonb(new) - array[
         'updated_at',
         'telegram_message_ru', 'telegram_message_en',
         'telegram_send_started_at_ru', 'telegram_send_started_at_en',
         'email_sent_at', 'email_sent_at_ru', 'email_sent_at_en',
         'email_send_started_at_ru', 'email_send_started_at_en'
       ]
     ) then
    raise exception 'video review content cannot change while a delivery is in progress';
  end if;
  return new;
end;
$$;

drop trigger if exists video_reviews_guard_delivery_history
  on public.video_reviews;
create trigger video_reviews_guard_delivery_history
before update or delete on public.video_reviews
for each row execute function public.guard_video_review_delivery_history();

insert into public.telegram_topics
  (chat_id, lang, topic_key, topic_title, thread_id, is_active)
values
  (-1003773738299, 'ru', 'video_reviews', 'Видеообзоры', 3, true),
  (-1003869302680, 'en', 'video_reviews', 'Video Reviews', 7, true)
on conflict (topic_key, lang) do nothing;

do $$
begin
  if not exists (
    select 1 from public.telegram_topics
    where topic_key = 'video_reviews'
      and lang = 'ru'
      and chat_id = -1003773738299
      and thread_id = 3
      and is_active = true
  ) then
    raise exception 'RU video_reviews Telegram route does not match the verified chat/thread';
  end if;
  if not exists (
    select 1 from public.telegram_topics
    where topic_key = 'video_reviews'
      and lang = 'en'
      and chat_id = -1003869302680
      and thread_id = 7
      and is_active = true
  ) then
    raise exception 'EN video_reviews Telegram route does not match the verified chat/thread';
  end if;
end;
$$;

comment on column public.video_reviews.publish_to_site_ru is
  'Show the RU version in the member website catalog.';
comment on column public.video_reviews.publish_to_site_en is
  'Show the EN version in the member website catalog.';
comment on column public.video_reviews.publish_to_telegram_ru is
  'Publish the RU version to the configured video_reviews Telegram topic.';
comment on column public.video_reviews.publish_to_telegram_en is
  'Publish the EN version to the configured video_reviews Telegram topic.';

commit;

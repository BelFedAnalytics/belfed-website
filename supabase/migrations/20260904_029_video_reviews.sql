-- BelFed Video Reviews
-- One editorial item contains both RU and EN variants so the two member sites
-- stay in sync. Videos remain hosted by an external provider.

begin;

create table if not exists public.video_reviews (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  status text not null default 'draft'
    check (status in ('draft', 'published', 'archived')),
  review_date date not null default current_date,
  sector text,
  duration_minutes integer check (duration_minutes is null or duration_minutes > 0),
  title_ru text,
  title_en text,
  summary_ru text,
  summary_en text,
  video_url_ru text,
  video_url_en text,
  embed_url_ru text,
  embed_url_en text,
  thumbnail_url_ru text,
  thumbnail_url_en text,
  related_content jsonb not null default '[]'::jsonb
    check (jsonb_typeof(related_content) = 'array'),
  published_at timestamptz,
  email_sent_at timestamptz,
  email_send_started_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint video_reviews_published_content_check check (
    status <> 'published' or (
      nullif(btrim(title_ru), '') is not null
      and nullif(btrim(video_url_ru), '') is not null
      and nullif(btrim(title_en), '') is not null
      and nullif(btrim(video_url_en), '') is not null
      and published_at is not null
    )
  )
);

create or replace function public.set_video_reviews_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists video_reviews_set_updated_at on public.video_reviews;
create trigger video_reviews_set_updated_at
before update on public.video_reviews
for each row execute function public.set_video_reviews_updated_at();

create index if not exists video_reviews_published_idx
  on public.video_reviews (published_at desc)
  where status = 'published';

alter table public.video_reviews enable row level security;

drop policy if exists video_reviews_member_read on public.video_reviews;
create policy video_reviews_member_read
  on public.video_reviews for select
  to authenticated
  using (
    status = 'published'
    and public.user_has_access(auth.uid())
  );

drop policy if exists video_reviews_admin_all on public.video_reviews;
create policy video_reviews_admin_all
  on public.video_reviews for all
  to authenticated
  using (public.user_is_admin(auth.uid()))
  with check (public.user_is_admin(auth.uid()));

alter table public.email_subscribers
  add column if not exists notify_video_reviews boolean not null default false;

create or replace function public.video_review_email_recipients()
returns table (
  subscriber_id uuid,
  email text,
  language text,
  segment text,
  unsubscribe_token text,
  bounce_count integer
)
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  select
    es.id,
    lower(btrim(p.email)),
    es.language,
    es.segment,
    p.unsubscribe_token::text,
    coalesce(es.bounce_count, 0)
  from public.email_subscribers es
  join public.profiles p on p.id = es.profile_id
  where es.notify_video_reviews = true
    and es.unsubscribed_at is null
    and coalesce(es.bounce_count, 0) < 3
    and coalesce(p.email_opt_out, false) = false
    and public.user_has_access(es.profile_id);
$$;

revoke all on function public.video_review_email_recipients() from public, anon, authenticated;
grant execute on function public.video_review_email_recipients() to service_role;

create or replace function public.claim_video_review_email_send(p_review_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_claimed integer;
begin
  update public.video_reviews
     set email_send_started_at = now()
   where id = p_review_id
     and status = 'published'
     and email_sent_at is null
     and (
       email_send_started_at is null
       or email_send_started_at < now() - interval '30 minutes'
     );
  get diagnostics v_claimed = row_count;
  return v_claimed = 1;
end;
$$;

revoke all on function public.claim_video_review_email_send(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_video_review_email_send(uuid)
  to service_role;

create or replace function public.set_email_global_preference(
  p_profile_id uuid,
  p_segment text,
  p_enabled boolean
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.profiles
     set email_opt_out = not p_enabled,
         email_opt_out_at = case when p_enabled then null else now() end,
         email_opt_out_source = case when p_enabled then null else 'preferences' end,
         updated_at = now()
   where id = p_profile_id;
  if not found then return false; end if;

  update public.email_subscribers
     set unsubscribed_at = case when p_enabled then null else now() end,
         confirmed_at = case
           when p_enabled then coalesce(confirmed_at, now())
           else confirmed_at
         end
   where profile_id = p_profile_id
     and segment = p_segment;
  if not found then raise exception 'email subscriber not found'; end if;
  return true;
end;
$$;

revoke all on function public.set_email_global_preference(uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.set_email_global_preference(uuid, text, boolean)
  to service_role;

alter table public.email_sends
  add column if not exists video_review_id uuid
  references public.video_reviews(id) on delete set null;

create index if not exists email_sends_video_review_idx
  on public.email_sends (video_review_id)
  where video_review_id is not null;

alter table public.email_sends
  drop constraint if exists email_sends_target_check;
alter table public.email_sends
  add constraint email_sends_target_check check (
    report_id is not null
    or position_event_id is not null
    or video_review_id is not null
  ) not valid;

drop index if exists public.email_sends_video_review_subscriber_uniq;
create unique index email_sends_video_review_subscriber_uniq
  on public.email_sends (video_review_id, subscriber_id)
  where video_review_id is not null;

comment on table public.video_reviews is
  'Bilingual member-only video reviews hosted on YouTube, VK Video or Rutube.';
comment on column public.video_reviews.related_content is
  'Array of {label_ru,label_en,url_ru,url_en}; URLs must be validated by the application.';
comment on column public.email_subscribers.notify_video_reviews is
  'Explicit opt-in for new video-review announcements; false by default.';

commit;

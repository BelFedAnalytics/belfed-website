-- Keep video review sectors stable across admin, catalog filters, and delivery.
begin;

do $$
begin
  if exists (
    select 1
    from public.video_reviews
    where sector is null
       or sector not in ('crypto', 'equities', 'commodities')
  ) then
    raise exception 'video_reviews contains unsupported sector values';
  end if;
end;
$$;

alter table public.video_reviews
  alter column sector set not null;

alter table public.video_reviews
  drop constraint if exists video_reviews_sector_check;

alter table public.video_reviews
  add constraint video_reviews_sector_check
  check (sector in ('crypto', 'equities', 'commodities'));

comment on column public.video_reviews.sector is
  'Fixed catalog sector: crypto, equities, or commodities.';

commit;

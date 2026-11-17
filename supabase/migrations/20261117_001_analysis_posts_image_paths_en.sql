-- Timeline: separate EN chart per image.
-- image_paths = RU/shared set; image_paths_en[i] (nullable) overrides image_paths[i] for EN only.
alter table public.analysis_posts
  add column if not exists image_paths_en jsonb not null default '[]'::jsonb;
comment on column public.analysis_posts.image_paths_en is
  'Optional EN-specific chart per image_paths index (null/empty = same chart as image_paths). RU always uses image_paths.';

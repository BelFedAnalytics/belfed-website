-- Keep the original shared cover as a read fallback for existing reports.
-- The editor migrates it into both explicit slots only when a report is saved.
ALTER TABLE public.analytics_reports
  ADD COLUMN IF NOT EXISTS cover_image_url_ru text,
  ADD COLUMN IF NOT EXISTS cover_image_url_en text;

COMMENT ON COLUMN public.analytics_reports.cover_image_url_ru IS
  'Russian report cover. Falls back to legacy cover_image_url when unset.';
COMMENT ON COLUMN public.analytics_reports.cover_image_url_en IS
  'English report cover. Falls back to legacy cover_image_url when unset.';

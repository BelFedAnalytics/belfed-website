-- Phase 5: remove broad SELECT policies that allow listing of public buckets.
-- Public buckets serve files via /storage/v1/object/public/<bucket>/<path>, which
-- bypasses RLS entirely and does NOT need a SELECT policy. Removing these policies
-- prevents attackers from enumerating files via /storage/v1/object/list/<bucket>.
drop policy if exists "Public can view charts"          on storage.objects;
drop policy if exists "analysis-images public read"     on storage.objects;

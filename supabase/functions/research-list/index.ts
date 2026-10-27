// research-list v1 — public /research/ index
// Returns published + public reports, newest-public first.
// No JWT required (verify_jwt=false), origin-locked to belfed.com/belfed.ru.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALLOWED_ORIGINS = new Set([
  "https://belfed.com", "https://www.belfed.com",
  "https://belfed.ru", "https://www.belfed.ru",
  // Local dev
  "http://localhost:3000", "http://localhost:5173", "http://localhost:8080",
  "http://127.0.0.1:3000", "http://127.0.0.1:5173", "http://127.0.0.1:8080",
]);

function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://belfed.com";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
    "Vary": "Origin",
    // Client-cache 60s, CDN-cache 300s with stale-while-revalidate.
    // Public /research/ index changes rarely; freshness within a minute is fine.
    "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
  };
}

function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json; charset=utf-8" },
  });
}

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CARD_COLUMNS = [
  "id",
  "slug",
  "report_date",
  "report_type",
  "title_ru",
  "title_en",
  "subtitle_ru",
  "subtitle_en",
  "asset_classes",
  "sectors",
  "tags",
  "cover_image_url",
  "cover_image_url_ru",
  "cover_image_url_en",
  "published_at",
  "published_public_at",
].join(", ");

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = cors(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405, headers);
  }

  const url = new URL(req.url);
  const params = url.searchParams;

  let q = supa
    .from("analytics_reports")
    .select(CARD_COLUMNS, { count: "exact" })
    .eq("is_public", true)
    .eq("status", "published");

  // Optional filters — not exposed on the initial /research/ page,
  // but ready for future filter chips (по классу активов, тегам).
  const type = params.get("type");
  if (type) q = q.eq("report_type", type);

  const assetClass = params.get("asset_class");
  if (assetClass) q = q.contains("asset_classes", [assetClass]);

  const sector = params.get("sector");
  if (sector) q = q.contains("sectors", [sector]);

  const tag = params.get("tag");
  if (tag) q = q.contains("tags", [tag]);

  // Newest-public first, tie-breaker by report_date desc, then created_at.
  q = q.order("published_public_at", { ascending: false, nullsFirst: false })
       .order("report_date", { ascending: false });

  const limit = Math.min(parseInt(params.get("limit") || "50", 10) || 50, 100);
  const offset = parseInt(params.get("offset") || "0", 10) || 0;
  q = q.range(offset, offset + limit - 1);

  const { data, error, count } = await q;
  if (error) {
    return json({ ok: false, error: error.message }, 500, headers);
  }

  return json({
    ok: true,
    items: data ?? [],
    total: count ?? 0,
    limit,
    offset,
  }, 200, headers);
});

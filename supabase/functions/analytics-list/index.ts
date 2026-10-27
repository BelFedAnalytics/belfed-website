// analytics-list v11 subscriber-gated
// v11 (2026-09-15): expose public-research flags to the admin list page:
//   is_public, published_public_at are added to FEED_COLUMNS and an optional
//   ?public=1|0 filter is accepted (admin-only, ignored for regular subscribers).
// Returns analytics feed rows only for subscribers/admins.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const BOT_SECRET = Deno.env.get("BOT_SHARED_SECRET") || "";

const ALLOWED_ORIGINS = new Set([
  "https://belfed.com", "https://www.belfed.com",
  "https://belfed.ru", "https://www.belfed.ru",
]);

function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://belfed.com";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info, x-bot-secret",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json" },
  });
}

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function extractUserToken(req: Request): string | null {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const tok = m[1].trim();
  if (!tok || (SUPABASE_ANON_KEY && tok === SUPABASE_ANON_KEY)) return null;
  return tok;
}

type Entitlement = { userId: string | null; hasAccess: boolean; isAdmin: boolean };

async function resolveEntitlement(req: Request): Promise<Entitlement> {
  if (BOT_SECRET && req.headers.get("x-bot-secret") === BOT_SECRET) {
    return { userId: null, hasAccess: true, isAdmin: true };
  }
  const token = extractUserToken(req);
  if (!token) return { userId: null, hasAccess: false, isAdmin: false };
  try {
    const { data, error } = await supa.auth.getUser(token);
    const uid = data?.user?.id;
    if (error || !uid) return { userId: null, hasAccess: false, isAdmin: false };
    const [accessQ, adminQ] = await Promise.all([
      supa.rpc("user_has_access", { uid }),
      supa.rpc("user_is_admin", { uid }),
    ]);
    return { userId: uid, hasAccess: !!accessQ.data, isAdmin: !!adminQ.data };
  } catch (_) {
    return { userId: null, hasAccess: false, isAdmin: false };
  }
}

const FEED_COLUMNS = "id, slug, report_date, report_type, title_ru, title_en, subtitle_ru, subtitle_en, asset_classes, sectors, tags, cover_image_url, cover_image_url_ru, cover_image_url_en, status, published_at, created_at, is_public, published_public_at";

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = cors(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "GET" && req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, headers);

  const ent = await resolveEntitlement(req);
  if (!ent.hasAccess) {
    return json({ ok: false, error: "subscription_required", total: 0, items: [] }, 403, headers);
  }

  const url = new URL(req.url);
  const params = url.searchParams;
  const statusParam = params.get("status");

  let q = supa
    .from("analytics_reports")
    .select(FEED_COLUMNS, { count: "exact" });

  if (ent.isAdmin && statusParam) {
    q = q.eq("status", statusParam);
  } else if (ent.isAdmin) {
    // Admin sees all by default.
  } else {
    q = q.eq("status", "published");
  }

  // v11: admin-only public filter. Regular subscribers never narrow by it.
  const publicParam = params.get("public");
  if (ent.isAdmin && publicParam !== null && publicParam !== "") {
    if (publicParam === "1" || publicParam === "true")  q = q.eq("is_public", true);
    if (publicParam === "0" || publicParam === "false") q = q.eq("is_public", false);
  }

  const type = params.get("type");
  if (type) q = q.eq("report_type", type);

  const assetClass = params.get("asset_class");
  if (assetClass) q = q.contains("asset_classes", [assetClass]);

  const sector = params.get("sector");
  if (sector) q = q.contains("sectors", [sector]);

  const tag = params.get("tag");
  if (tag) q = q.contains("tags", [tag]);

  const dateFrom = params.get("date_from");
  if (dateFrom) q = q.gte("report_date", dateFrom);

  const dateTo = params.get("date_to");
  if (dateTo) q = q.lte("report_date", dateTo);

  const search = params.get("q");
  if (search && search.length >= 2) {
    const s = search.replace(/[%_]/g, "");
    q = q.or(`title_ru.ilike.%${s}%,title_en.ilike.%${s}%,subtitle_ru.ilike.%${s}%,subtitle_en.ilike.%${s}%`);
  }

  const limit = Math.min(parseInt(params.get("limit") || "20", 10) || 20, 100);
  const offset = parseInt(params.get("offset") || "0", 10) || 0;

  q = q.order("report_date", { ascending: false }).order("created_at", { ascending: false }).range(offset, offset + limit - 1);

  const { data, error, count } = await q;
  if (error) return json({ ok: false, error: error.message }, 500, headers);

  return json({ ok: true, items: data ?? [], total: count ?? 0, limit, offset }, 200, headers);
});

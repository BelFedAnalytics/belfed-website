// timeline-list v10 (2026-11-17): also returns image_paths_en (EN chart per image_paths index; null = same as image_paths).
// timeline-list — subscriber-gated Timeline feed for analytics page.
// Returns published analysis_posts where destination='timeline'.
// Mirrors analytics-list entitlement + CORS pattern.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const BOT_SECRET = Deno.env.get("BOT_SHARED_SECRET") || "";

const ALLOWED_ORIGINS = new Set([
  "https://belfed.com", "https://www.belfed.com",
  "https://belfed.ru", "https://www.belfed.ru",
]);

function cors(origin) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://belfed.com";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info, x-bot-secret",
    "Vary": "Origin",
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json" },
  });
}

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function extractUserToken(req) {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const tok = m[1].trim();
  if (!tok || (SUPABASE_ANON_KEY && tok === SUPABASE_ANON_KEY)) return null;
  return tok;
}

async function resolveEntitlement(req) {
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

const FEED_COLUMNS = "id, slug, destination, headline_ru, headline_en, body_ru, body_en, source, categories, asset_class, image_paths, image_paths_en, report_slug, status, published_at, created_at";

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

  let q = supa
    .from("analysis_posts")
    .select(FEED_COLUMNS, { count: "exact" })
    .eq("destination", "timeline");

  const statusParam = params.get("status");
  if (ent.isAdmin && statusParam) {
    q = q.eq("status", statusParam);
  } else if (!ent.isAdmin) {
    q = q.eq("status", "published");
  }

  const cat = params.get("category");
  if (cat && cat.toLowerCase() !== "all") {
    q = q.contains("categories", [cat.toLowerCase()]);
  }

  const search = params.get("q");
  if (search && search.length >= 2) {
    const s = search.replace(/[%_]/g, "");
    q = q.or(
      `headline_ru.ilike.%${s}%,headline_en.ilike.%${s}%,body_ru.ilike.%${s}%,body_en.ilike.%${s}%,source.ilike.%${s}%`
    );
  }

  const limit = Math.min(parseInt(params.get("limit") || "20", 10) || 20, 100);
  const offset = parseInt(params.get("offset") || "0", 10) || 0;

  q = q
    .order("published_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await q;
  if (error) return json({ ok: false, error: error.message }, 500, headers);

  return json({ ok: true, items: data ?? [], total: count ?? 0, limit, offset }, 200, headers);
});

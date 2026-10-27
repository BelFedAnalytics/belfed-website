// analytics-get v18 (2026-10-26): slug_aliases fallback for renamed reports.
// analytics-get v11
// v11 (2026-08-17): expand linked_post enrichment with body_ru/en, image_paths,
//   tradingview_url. The website report view inlines the referenced post's body
//   and charts so readers can consume the report without leaving the page.
//   Storage images are referenced by public URL only — the same object is shared
//   with the timeline, cached by CDN and browser (no duplication).
// v10 (2026-08-17): linked_post enrichment for report sections.
//   - When a section has linked_post_id, we fetch the referenced analysis_posts row
//     and attach it as section.linked_post = { id, slug, ticker, destination,
//     headline_ru, headline_en, status, message_id_ru, message_id_en,
//     publish_to_ru, publish_to_en }.
//   - Enrichment is a single grouped SELECT keyed by ids to keep it O(1) queries,
//     regardless of section count.
//   - If a linked post is not published yet, we still attach it so admin previews
//     can show "linked post draft" indicators. Public consumers should check
//     status === 'published' before rendering the card.
// v3 subscriber-gated retry (previous)
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
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info, x-bot-secret",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, "content-type": "application/json" } });
}

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

function extractUserToken(req: Request): string | null {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const tok = m[1].trim();
  if (!tok || (SUPABASE_ANON_KEY && tok === SUPABASE_ANON_KEY)) return null;
  return tok;
}

async function resolveEntitlement(req: Request): Promise<{ hasAccess: boolean; isAdmin: boolean }> {
  if (BOT_SECRET && req.headers.get("x-bot-secret") === BOT_SECRET) return { hasAccess: true, isAdmin: true };
  const token = extractUserToken(req);
  if (!token) return { hasAccess: false, isAdmin: false };
  try {
    const { data, error } = await supa.auth.getUser(token);
    const uid = data?.user?.id;
    if (error || !uid) return { hasAccess: false, isAdmin: false };
    const [accessQ, adminQ] = await Promise.all([
      supa.rpc("user_has_access", { uid }),
      supa.rpc("user_is_admin", { uid }),
    ]);
    return { hasAccess: !!accessQ.data, isAdmin: !!adminQ.data };
  } catch (_) {
    return { hasAccess: false, isAdmin: false };
  }
}

const TEASER_COLUMNS = ["id", "slug", "status", "report_date", "report_type", "asset_classes", "sectors", "tags", "cover_image_url", "cover_image_url_ru", "cover_image_url_en", "title_ru", "title_en", "subtitle_ru", "subtitle_en", "published_at", "created_at"];
function pickTeaser(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of TEASER_COLUMNS) out[k] = row[k];
  return out;
}

// v13 (2026-09-14): added company_name — asset analyses are published without a
// headline, so the report view builds the title from $TICKER + company name.
// v11: fetch linked_post rows in a single grouped query and attach to sections.
// Selects everything the report view needs to render the linked post inline.
async function enrichSectionsWithLinkedPosts(sections: any[]): Promise<any[]> {
  const ids: string[] = [];
  for (const s of sections) {
    if (s && s.linked_post_id && !ids.includes(s.linked_post_id)) ids.push(s.linked_post_id);
  }
  if (ids.length === 0) return sections;

  const { data: posts, error } = await supa
    .from("analysis_posts")
    .select("id, slug, ticker, company_name, destination, headline_ru, headline_en, body_ru, body_en, image_paths, tradingview_url, status, message_id_ru, message_id_en, publish_to_ru, publish_to_en, published_at")
    .in("id", ids);
  if (error) {
    // Fail soft: don't blow up the whole GET if enrichment fails; log server-side
    // and return sections as-is so the report still renders.
    console.warn("[analytics-get v10] linked post enrichment failed:", error.message);
    return sections;
  }

  const byId = new Map<string, any>();
  for (const p of posts ?? []) byId.set(p.id, p);

  return sections.map((s) => {
    if (!s || !s.linked_post_id) return s;
    const lp = byId.get(s.linked_post_id);
    return { ...s, linked_post: lp ?? null };
  });
}

Deno.serve(async (req) => {
  const headers = cors(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405, headers);

  const url = new URL(req.url);
  const slug = url.searchParams.get("slug");
  const id = url.searchParams.get("id");
  const teaserOnly = url.searchParams.get("teaser") === "1";
  if (!slug && !id) return json({ ok: false, error: "slug_or_id_required" }, 400, headers);

  const ent = await resolveEntitlement(req);
  let qReport = supa.from("analytics_reports").select("*").limit(1);
  if (id) qReport = qReport.eq("id", id); else qReport = qReport.eq("slug", slug);
  if (!ent.isAdmin) qReport = qReport.eq("status", "published");
  const { data: reports0, error: rErr } = await qReport;
  if (rErr) return json({ ok: false, error: rErr.message }, 500, headers);
  let reports = reports0;
  // v18: renamed slugs keep working (old Telegram buttons and emails)
  if (!reports?.length && slug && !id) {
    let qAlias = supa.from("analytics_reports").select("*").contains("slug_aliases", [slug]).limit(1);
    if (!ent.isAdmin) qAlias = qAlias.eq("status", "published");
    const { data: aliased } = await qAlias;
    if (aliased?.length) reports = aliased;
  }
  const report = reports?.[0];
  if (!report) return json({ ok: false, error: "not_found" }, 404, headers);

  if (teaserOnly || !ent.hasAccess) {
    if (report.status !== "published") return json({ ok: false, error: "not_found" }, 404, headers);
    return json({ ok: true, report: pickTeaser(report), sections: [], gated: !ent.hasAccess }, 200, headers);
  }

  const { data: sections, error: sErr } = await supa.from("analytics_sections").select("*").eq("report_id", report.id).order("position", { ascending: true });
  if (sErr) return json({ ok: false, error: sErr.message }, 500, headers);
  const enriched = await enrichSectionsWithLinkedPosts(sections ?? []);
  return json({ ok: true, report, sections: enriched }, 200, headers);
});

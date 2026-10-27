// analytics-save v14
// v14 (2026-09-15): public research support.
//   - Top-level is_public (bool) is persisted on analytics_reports.
//   - Per-report CTA overrides persisted: cta_headline_ru/en, cta_body_ru/en,
//     cta_ticker_teaser_ru/en (empty string is stored as NULL so the renderer
//     falls back to its default copy).
//   - sections[].is_public (bool, default true) is persisted. This MUST stay in
//     sectionsPayload: every save deletes and reinserts all sections, so a
//     missing field would silently reset section visibility to the DB default.
// v12 (2026-08-17): linked sections + autopublish support.
//   - sections[].linked_post_id (uuid|null) is now persisted.
//   - Top-level publish_mode ('manual'|'auto_after_links'), publish_after (timestamptz|null)
//     are now persisted on analytics_reports.
//   - Backward compatible: old admin builds that don't send these fields continue to work.
// v8 changes (robustness):
//   - Replace .single() with .maybeSingle() on UPDATE and INSERT paths to avoid
//     the cryptic "Cannot coerce the result to a single JSON object" error.
//   - UPDATE path: if the row with body.id no longer exists (0 rows), fall back
//     to INSERT so the user's work is saved instead of failing.
//   - INSERT path: if no row returned, return a clear error.
// v3 changes (email broadcast support):
//   - email_send_to_premium boolean
//   - email_send_to_leads boolean
//   - email_send_at timestamptz (optional explicit time)
//   - On status=published: if email_send_at is null, default to published_at + 30 min
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_SECRET = Deno.env.get("BOT_SHARED_SECRET")!;

const ALLOWED_ORIGINS = new Set([
  "https://belfed.com", "https://www.belfed.com",
  "https://belfed.ru", "https://www.belfed.ru",
]);

function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://belfed.com";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info, x-bot-secret",
    "Vary": "Origin",
  };
}

function slugify(s: string): string {
  const map: Record<string, string> = {
    'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z','и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'ts','ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya'
  };
  return s.toLowerCase().split('').map(c => map[c] ?? c).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function normalizeChartImages(raw: unknown): Array<{ url: string; caption_ru: string; caption_en: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ url: string; caption_ru: string; caption_en: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const url = String((item as any).url ?? "").trim();
    if (!url) continue;
    out.push({
      url,
      caption_ru: String((item as any).caption_ru ?? ""),
      caption_en: String((item as any).caption_en ?? ""),
    });
    if (out.length >= 5) break;
  }
  return out;
}

// v12: rudimentary uuid v4-ish validator (accepts any 8-4-4-4-12 hex).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function normalizeUuid(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return UUID_RE.test(s) ? s : null;
}

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = cors(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method" }), {
      status: 405, headers: { ...headers, "content-type": "application/json" },
    });
  }
  if (req.headers.get("x-bot-secret") !== BOT_SECRET) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401, headers: { ...headers, "content-type": "application/json" },
    });
  }

  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ ok: false, error: "bad_json" }), {
      status: 400, headers: { ...headers, "content-type": "application/json" },
    });
  }

  const status = body.status ?? "draft";
  const titleRu = (body.title_ru ?? "").toString().trim();
  const titleEn = (body.title_en ?? "").toString().trim();

  if (!body.report_date || !body.report_type) {
    return new Response(JSON.stringify({ ok: false, error: "missing_required_fields", missing: ["report_date","report_type"].filter(k => !body[k]) }), {
      status: 400, headers: { ...headers, "content-type": "application/json" },
    });
  }

  if (status === "draft") {
    if (!titleRu && !titleEn) {
      return new Response(JSON.stringify({ ok: false, error: "missing_required_fields", missing: ["title_ru_or_title_en"] }), {
        status: 400, headers: { ...headers, "content-type": "application/json" },
      });
    }
  } else {
    if (!titleRu) {
      return new Response(JSON.stringify({ ok: false, error: "missing_required_fields", missing: ["title_ru"] }), {
        status: 400, headers: { ...headers, "content-type": "application/json" },
      });
    }
  }

  let slug = body.slug as string | undefined;
  if (!slug) {
    const slugSource = titleRu || titleEn || "report";
    const base = `${body.report_date}-${slugify(slugSource)}`;
    slug = base;
    let i = 1;
    while (true) {
      const candidate = i === 1 ? base : `${base}-${i}`;
      const { data: existing } = await supa
        .from("analytics_reports")
        .select("id")
        .eq("slug", candidate)
        .maybeSingle();
      if (!existing || (body.id && existing.id === body.id)) {
        slug = candidate;
        break;
      }
      i++;
      if (i > 100) break;
    }
  }

  const reportPayload: any = {
    slug,
    report_date: body.report_date,
    report_type: body.report_type,
    title_ru: titleRu || null,
    title_en: titleEn || null,
    subtitle_ru: body.subtitle_ru ?? null,
    subtitle_en: body.subtitle_en ?? null,
    asset_classes: body.asset_classes ?? [],
    sectors: body.sectors ?? [],
    tags: body.tags ?? [],
    cover_image_url: body.cover_image_url ?? null,
    status,
    created_by: body.created_by ?? null,
  };

  // Optional localized covers. Omitted fields from older clients must not clear
  // an already saved translation; explicit null removes only that language.
  for (const lang of ["ru", "en"]) {
    const key = `cover_image_url_${lang}`;
    if (body[key] !== undefined) reportPayload[key] = body[key] || null;
  }

  // Email broadcast fields (v3)
  if (body.email_send_to_premium !== undefined) {
    reportPayload.email_send_to_premium = !!body.email_send_to_premium;
  }
  if (body.email_send_to_leads !== undefined) {
    reportPayload.email_send_to_leads = !!body.email_send_to_leads;
  }
  if (body.email_send_at !== undefined) {
    reportPayload.email_send_at = body.email_send_at || null;
  }

  // v12: autopublish fields. Only accept known enum values.
  if (body.publish_mode !== undefined) {
    const pm = String(body.publish_mode);
    reportPayload.publish_mode = (pm === "auto_after_links") ? "auto_after_links" : "manual";
  }
  if (body.publish_after !== undefined) {
    // Accept null or ISO string. Bad values fall through to null rather than throwing.
    if (body.publish_after === null || body.publish_after === "") {
      reportPayload.publish_after = null;
    } else {
      const d = new Date(String(body.publish_after));
      reportPayload.publish_after = isNaN(d.getTime()) ? null : d.toISOString();
    }
  }

  // v14: public research access (report level) + per-report CTA overrides.
  if (body.is_public !== undefined) {
    reportPayload.is_public = !!body.is_public;
  }
  for (const k of ["cta_headline_ru","cta_headline_en","cta_body_ru","cta_body_en","cta_ticker_teaser_ru","cta_ticker_teaser_en"]) {
    if (body[k] !== undefined) {
      const raw = body[k];
      const v = (raw === null || raw === undefined) ? "" : String(raw).trim();
      reportPayload[k] = v === "" ? null : v;
    }
  }

  const willPublishNow = reportPayload.status === "published" && !body.published_at_keep;
  if (willPublishNow) {
    reportPayload.published_at = new Date().toISOString();
    const emailEnabled =
      reportPayload.email_send_to_premium === true ||
      reportPayload.email_send_to_leads === true ||
      body.email_send_to_premium === true ||
      body.email_send_to_leads === true;
    if (emailEnabled && !body.email_send_at) {
      const sendAt = new Date(Date.now() + 30 * 60 * 1000);
      reportPayload.email_send_at = sendAt.toISOString();
    }
  }

  let reportId: string | null = null;

  if (body.id) {
    // Try to update the existing row.
    const { data, error } = await supa
      .from("analytics_reports")
      .update(reportPayload)
      .eq("id", body.id)
      .select("id")
      .maybeSingle();
    if (error) {
      return new Response(JSON.stringify({ ok: false, error: error.message }), {
        status: 500, headers: { ...headers, "content-type": "application/json" },
      });
    }
    if (data && data.id) {
      reportId = data.id;
    } else {
      // Stale id: the row no longer exists. Fall back to INSERT so work is saved.
      const { data: insData, error: insErr } = await supa
        .from("analytics_reports")
        .insert(reportPayload)
        .select("id")
        .maybeSingle();
      if (insErr) {
        return new Response(JSON.stringify({ ok: false, error: insErr.message }), {
          status: 500, headers: { ...headers, "content-type": "application/json" },
        });
      }
      if (!insData || !insData.id) {
        return new Response(JSON.stringify({ ok: false, error: "insert_returned_no_row" }), {
          status: 500, headers: { ...headers, "content-type": "application/json" },
        });
      }
      reportId = insData.id;
    }
  } else {
    const { data, error } = await supa
      .from("analytics_reports")
      .insert(reportPayload)
      .select("id")
      .maybeSingle();
    if (error) {
      return new Response(JSON.stringify({ ok: false, error: error.message }), {
        status: 500, headers: { ...headers, "content-type": "application/json" },
      });
    }
    if (!data || !data.id) {
      return new Response(JSON.stringify({ ok: false, error: "insert_returned_no_row" }), {
        status: 500, headers: { ...headers, "content-type": "application/json" },
      });
    }
    reportId = data.id;
  }

  if (Array.isArray(body.sections)) {
    await supa.from("analytics_sections").delete().eq("report_id", reportId);
    if (body.sections.length > 0) {
      const sectionsPayload = body.sections.map((s: any, idx: number) => {
        const chartImages = normalizeChartImages(s.chart_images);
        // v12: normalize linked_post_id — invalid strings become null (silent) so the
        // admin UI never fails-hard on a stale/bad picker value.
        const linkedPostId = normalizeUuid(s.linked_post_id);
        return {
          report_id: reportId,
          position: s.position ?? (idx + 1),
          is_conclusion: !!s.is_conclusion,
          section_label_ru: s.section_label_ru ?? null,
          section_label_en: s.section_label_en ?? null,
          headline_ru: s.headline_ru ?? null,
          headline_en: s.headline_en ?? null,
          body_ru: s.body_ru ?? null,
          body_en: s.body_en ?? null,
          chart_image_url: s.chart_image_url ?? null,
          chart_caption_ru: s.chart_caption_ru ?? null,
          chart_caption_en: s.chart_caption_en ?? null,
          chart_images: chartImages,
          linked_post_id: linkedPostId,
          // v14: section-level public visibility. Undefined means "public" to match
          // the analytics_sections.is_public DB default.
          is_public: (s.is_public === undefined || s.is_public === null) ? true : !!s.is_public,
        };
      });
      const { error: sErr } = await supa.from("analytics_sections").insert(sectionsPayload);
      if (sErr) {
        return new Response(JSON.stringify({ ok: false, error: "sections: " + sErr.message }), {
          status: 500, headers: { ...headers, "content-type": "application/json" },
        });
      }
    }
  }

  return new Response(JSON.stringify({ ok: true, report_id: reportId, slug }), {
    status: 200, headers: { ...headers, "content-type": "application/json" },
  });
});

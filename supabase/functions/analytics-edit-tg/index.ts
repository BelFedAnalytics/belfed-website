// analytics-edit-tg v6 (2026-10-30)
// v6: format-aware section editing, matching analytics-publish v45.
//   - Sections published as an article (stored mode "article") are re-rendered with
//     editMessageText + rich_message (same layout as the publisher).
//   - Text-only sections are edited as plain messages with the 4096 limit, not 1024.
//   - Section text is now built by the same code as the publisher (mini footer, no chart
//     caption), so an edit no longer changes the look of a published section.
//   - Linked sections (their text lives in the analysis post) are skipped, not overwritten.
//   - A message cannot change type in place: if the text no longer fits the format it was
//     published in, it is trimmed and the response says "republish_needed".
// analytics-edit-tg v5
// Re-renders captions for a published report. Sections have NO link/button.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_SECRET = Deno.env.get("BOT_SHARED_SECRET")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const BOT_USERNAME = Deno.env.get("BOT_USERNAME") ?? "BelfedBot";

const ALLOWED_ORIGINS = new Set([
  "https://belfed.com", "https://www.belfed.com",
  "https://belfed.ru", "https://www.belfed.ru",
]);

function cors(origin) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://belfed.com";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info, x-bot-secret",
    "Vary": "Origin",
  };
}

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const TG_CAPTION_LIMIT = 1024;

function getCharts(section, lang = "ru") {
  const arr = Array.isArray(section?.chart_images) ? section.chart_images : [];
  const out = [];
  for (const it of arr) {
    if (it && typeof it === "object" && typeof it.url === "string" && it.url) {
      const url = lang === "en" && typeof it.url_en === "string" && it.url_en ? it.url_en : it.url;
      out.push({ url, caption_ru: it.caption_ru, caption_en: it.caption_en });
    }
  }
  if (out.length === 0 && typeof section?.chart_image_url === "string" && section.chart_image_url) {
    out.push({
      url: section.chart_image_url,
      caption_ru: section.chart_caption_ru ?? "",
      caption_en: section.chart_caption_en ?? "",
    });
  }
  return out;
}

function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function trimCaption(s, limit = TG_CAPTION_LIMIT) {
  if (s.length <= limit) return s;
  const cut = s.lastIndexOf("\n\n", limit - 20);
  if (cut > limit * 0.6) return s.slice(0, cut) + "\n\n…";
  return s.slice(0, limit - 20) + "\n…";
}

function fmtDate(d, lang) {
  const [y, m, day] = d.split("-");
  const monthsRu = ["янв","фев","мар","апр","май","июн","июл","авг","сен","окт","ноя","дек"];
  const monthsEn = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const months = lang === "ru" ? monthsRu : monthsEn;
  return `${parseInt(day,10)} ${months[parseInt(m,10)-1]} ${y}`;
}

function buildFooter(report, lang) {
  const date = fmtDate(report.report_date, lang);
  const domain = lang === "ru" ? "belfed.ru" : "belfed.com";
  return `· BELFED ANALYTICS · ${date} · @${BOT_USERNAME} · ${domain}`;
}

function labelTail(label) {
  return label
    .replace(/^[\s·•\-—]*\d+[.)\s]*\s*/u, "")
    .trim();
}

// ===== TG_SECTION_FORMAT:BEGIN =====
// v45 (2026-10-30): automatic Telegram format per report section. This block is kept
// byte-identical in analytics-publish, analytics-republish-section and analytics-edit-tg
// (tests/report-section-format.test.cjs enforces it) and mirrored in admin-analytics.html.
//   - section has charts and its message text fits 1024 visible chars -> "photo" (caption)
//   - section has charts and the text is longer                      -> "article" (rich message)
//   - section has no charts and the text fits 4096 visible chars      -> "text" (plain message)
//   - section has no charts and the text is longer                   -> "article" (rich message)
// Telegram counts message/caption length AFTER entity parsing, so HTML tags and entities
// do not count: the decision is made on the visible text.
const TG_FMT_CAPTION_LIMIT = 1024;
const TG_FMT_TEXT_LIMIT = 4096;
const TG_FMT_RICH_LIMIT = 32768;
const TG_FMT_RICH_MAX_BLOCKS = 500;
const RICH_GAP = "<p>&nbsp;</p>";

function tgVisibleLength(html: string): number {
  const plain = String(html ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&");
  return plain.length;
}

function chooseSectionFormat(captionHtml: string, chartCount: number): { format: "photo" | "text" | "article"; len: number; limit: number } {
  const len = tgVisibleLength(captionHtml);
  if (chartCount > 0) {
    return len <= TG_FMT_CAPTION_LIMIT
      ? { format: "photo", len, limit: TG_FMT_CAPTION_LIMIT }
      : { format: "article", len, limit: TG_FMT_RICH_LIMIT };
  }
  return len <= TG_FMT_TEXT_LIMIT
    ? { format: "text", len, limit: TG_FMT_TEXT_LIMIT }
    : { format: "article", len, limit: TG_FMT_RICH_LIMIT };
}

// Plain text with blank-line separated paragraphs -> <p> blocks with an empty paragraph
// between them, so Telegram renders a visible gap (owner-approved layout "B2").
function richParas(text: string): string {
  return String(text ?? "")
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => `<p>${escapeHtml(b).split("\n").join("<br>")}</p>`)
    .join(RICH_GAP);
}

// Article (rich message) for one section: label, heading, body, charts inline, footer.
// `parts` comes from buildSectionCaptions(...).parts so the article and the classic
// message are always derived from the same label / headline / footer logic.
function buildSectionArticleHtml(parts: any, charts: any[], lang: string, report: any): string {
  const out: string[] = [];
  if (parts.headline) {
    if (parts.label) out.push(`<p>// ${escapeHtml(parts.label)}</p>`);
    out.push(`<h3>${escapeHtml(parts.headline)}</h3>`);
  } else if (parts.label) {
    out.push(`<h3>// ${escapeHtml(parts.label)}</h3>`);
  }
  if (String(parts.body ?? "").trim()) out.push(richParas(parts.body));
  if (parts.extraHtml) out.push(RICH_GAP + `<p>${parts.extraHtml}</p>`);
  const figures = charts.map((c: any) => `<figure><img src="${escapeHtml(c.url)}"/></figure>`);
  if (figures.length) out.push(RICH_GAP + figures.join(RICH_GAP));
  const bot = `<a href="https://t.me/${BOT_USERNAME}">@${BOT_USERNAME}</a>`;
  const footer = parts.isConclusion
    ? `· ${parts.partsLabel}<br>· BELFED ANALYTICS · ${fmtDate(report.report_date, lang)} · ${bot} · ${lang === "ru" ? "belfed.ru" : "belfed.com"}`
    : `· ${parts.partsLabel}  ${bot}`;
  out.push(RICH_GAP + `<footer>${footer}</footer>`);
  return out.join("");
}

// Telegram limits for a rich message: 32768 characters of text and 500 blocks.
function richFits(html: string): { ok: boolean; reason: string | null; len: number; blocks: number } {
  const len = tgVisibleLength(html);
  const blocks = (html.match(/<(p|h[1-6]|figure|footer|blockquote)[\s>]/g) ?? []).length;
  if (len > TG_FMT_RICH_LIMIT) return { ok: false, reason: `too_long:${len}/${TG_FMT_RICH_LIMIT}`, len, blocks };
  if (blocks > TG_FMT_RICH_MAX_BLOCKS) return { ok: false, reason: `too_many_blocks:${blocks}/${TG_FMT_RICH_MAX_BLOCKS}`, len, blocks };
  return { ok: true, reason: null, len, blocks };
}
// ===== TG_SECTION_FORMAT:END =====

function buildCover(report, sectionsCount, lang) {
  const date = fmtDate(report.report_date, lang);
  const title = lang === "ru" ? report.title_ru : (report.title_en ?? report.title_ru);
  const subtitle = lang === "ru" ? report.subtitle_ru : (report.subtitle_en ?? report.subtitle_ru);
  const partsLabel = lang === "ru" ? `Часть 1/${sectionsCount + 1}` : `Part 1/${sectionsCount + 1}`;
  const lines = [`// BELFED ANALYTICS · ${date}`, "", `<b>${escapeHtml(title)}</b>`];
  if (subtitle) lines.push("", escapeHtml(subtitle));
  lines.push("", `· ${partsLabel}`, buildFooter(report, lang));
  return lines.join("\n");
}

function buildFullFooter(report, lang) { return buildFooter(report, lang); }
function buildMiniFooter(partsLabel) { return `· ${partsLabel}  @${BOT_USERNAME}`; }

// Same text as analytics-publish buildSectionCaptions(...).full, plus the raw pieces for the article.
function buildSectionCaptions(section, idx, total, lang, report) {
  const labelRaw = (lang === "ru" ? section.section_label_ru : section.section_label_en) ?? "";
  const label = labelRaw.trim();
  const headlineRaw = (lang === "ru" ? section.headline_ru : section.headline_en) ?? "";
  const body = (lang === "ru" ? section.body_ru : section.body_en) ?? "";
  const extraHtml = section.extra_html ?? "";
  const isConclusion = !!section.is_conclusion;
  const partsLabel = isConclusion
    ? (lang === "ru" ? "ГЛАВНЫЙ ВЫВОД" : "KEY TAKEAWAY")
    : (lang === "ru" ? `Часть ${idx + 2}/${total + 1}` : `Part ${idx + 2}/${total + 1}`);
  const labelClean = labelTail(label).toLocaleLowerCase();
  const headlineClean = headlineRaw.trim().toLocaleLowerCase();
  const headline = (headlineClean && headlineClean !== labelClean) ? headlineRaw : "";

  const lines = [];
  if (label) lines.push(`// ${escapeHtml(label)}`);
  if (headline) lines.push(`<b>${escapeHtml(headline)}</b>`);
  if (lines.length) lines.push("");
  if (body) lines.push(escapeHtml(body));
  if (extraHtml) lines.push("", extraHtml);
  lines.push("");
  if (isConclusion) lines.push(`· ${partsLabel}`, buildFullFooter(report, lang));
  else lines.push(buildMiniFooter(partsLabel));
  return { full: lines.join("\n"), parts: { label, headline, body, extraHtml, partsLabel, isConclusion } };
}

async function tgEditCaption(chatId, messageId, caption) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageCaption`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, caption, parse_mode: "HTML" }),
  });
  let p; try { p = await res.json(); } catch { p = {}; }
  if (p.ok) return "ok";
  const desc = String(p.description ?? "").toLowerCase();
  if (desc.includes("can't be edited") || desc.includes("not found") || desc.includes("not modified")) return "stale";
  console.error("editMessageCaption error:", p);
  return "error";
}

async function tgEditText(chatId, messageId, text) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  let p; try { p = await res.json(); } catch { p = {}; }
  if (p.ok) return "ok";
  const desc = String(p.description ?? "").toLowerCase();
  if (desc.includes("can't be edited") || desc.includes("not found") || desc.includes("not modified")) return "stale";
  console.error("editMessageText error:", p);
  return "error";
}

async function tgEditRich(chatId, messageId, html) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, rich_message: { html } }),
  });
  let p; try { p = await res.json(); } catch { p = {}; }
  if (p.ok) return "ok";
  const desc = String(p.description ?? "").toLowerCase();
  if (desc.includes("can't be edited") || desc.includes("not found") || desc.includes("not modified")) return "stale";
  console.error("editMessageText (rich) error:", p);
  return "error";
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = cors(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ ok: false, error: "method" }), { status: 405, headers: { ...headers, "content-type": "application/json" } });
  if (req.headers.get("x-bot-secret") !== BOT_SECRET) return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { ...headers, "content-type": "application/json" } });

  let body;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ ok: false, error: "bad_json" }), { status: 400, headers: { ...headers, "content-type": "application/json" } });
  }
  if (!body.report_id) return new Response(JSON.stringify({ ok: false, error: "report_id_required" }), { status: 400, headers: { ...headers, "content-type": "application/json" } });

  const { data: report } = await supa.from("analytics_reports").select("*").eq("id", body.report_id).maybeSingle();
  if (!report) return new Response(JSON.stringify({ ok: false, error: "not_found" }), { status: 404, headers: { ...headers, "content-type": "application/json" } });
  const { data: sections } = await supa.from("analytics_sections").select("*").eq("report_id", body.report_id).order("position", { ascending: true });
  const allSections = sections ?? [];
  const langs = body.langs ?? ["ru", "en"];

  const out = {};
  for (const lang of langs) {
    const idsField = lang === "ru" ? "tg_message_ids_ru" : "tg_message_ids_en";
    const ids = report[idsField];
    if (!ids || !ids.cover) { out[lang] = { skipped: "no_message_ids" }; continue; }
    const chatId = ids.chat_id;
    const status = { cover: null, sections: [] };
    const coverText = buildCover(report, allSections.length, lang);
    const coverUrl = report[`cover_image_url_${lang}`] || report.cover_image_url || null;
    if (coverUrl) status.cover = await tgEditCaption(chatId, ids.cover, trimCaption(coverText));
    else status.cover = await tgEditText(chatId, ids.cover, coverText);

    for (let i = 0; i < allSections.length; i++) {
      const section = allSections[i];
      const ref = (ids.sections ?? []).find((x) => x.section_id === section.id || x.position === section.position);
      if (!ref) { status.sections.push({ position: section.position, skipped: "no_msg_id" }); continue; }
      if (section.linked_post_id) { status.sections.push({ position: section.position, skipped: "linked_section" }); continue; }
      const charts = getCharts(section, lang);
      const caps = buildSectionCaptions(section, i, allSections.length, lang, report);
      const fmt = chooseSectionFormat(caps.full, charts.length);
      const publishedAsArticle = ref.mode === "article";
      const publishedAsText = typeof ref.mode === "string" && ref.mode.startsWith("no_photo");
      let photoStatus = null; let note = null;
      if (ref.photo_msg_id) {
        if (publishedAsArticle) {
          const html = buildSectionArticleHtml(caps.parts, charts, lang, report);
          const fit = richFits(html);
          photoStatus = fit.ok ? await tgEditRich(chatId, ref.photo_msg_id, html) : "article_too_large";
        } else if (publishedAsText || (!ref.mode && charts.length === 0)) {
          // plain message: 4096 characters
          if (fmt.format === "article") note = "republish_needed";
          const t = tgVisibleLength(caps.full) <= TG_FMT_TEXT_LIMIT ? caps.full : trimCaption(caps.full, TG_FMT_TEXT_LIMIT);
          photoStatus = await tgEditText(chatId, ref.photo_msg_id, t);
        } else {
          // photo / album caption: 1024 characters
          if (fmt.format === "article") note = "republish_needed";
          const t = tgVisibleLength(caps.full) <= TG_FMT_CAPTION_LIMIT ? caps.full : trimCaption(caps.full);
          photoStatus = await tgEditCaption(chatId, ref.photo_msg_id, t);
        }
      }
      status.sections.push({ position: section.position, photo: photoStatus, format: publishedAsArticle ? "article" : (publishedAsText || (!ref.mode && charts.length === 0) ? "text" : "photo"), ...(note ? { note } : {}) });
      await new Promise(r => setTimeout(r, 250));
    }
    out[lang] = status;
  }

  return new Response(JSON.stringify({ ok: true, edit_status: out }), { status: 200, headers: { ...headers, "content-type": "application/json" } });
});

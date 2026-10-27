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

function getCharts(section) {
  const arr = Array.isArray(section?.chart_images) ? section.chart_images : [];
  const out = [];
  for (const it of arr) {
    if (it && typeof it === "object" && typeof it.url === "string" && it.url) {
      out.push({ url: it.url, caption_ru: it.caption_ru, caption_en: it.caption_en });
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

function buildSectionCaption(section, idx, total, lang, report) {
  const label = (lang === "ru" ? section.section_label_ru : section.section_label_en) ?? "";
  const headlineRaw = (lang === "ru" ? section.headline_ru : section.headline_en) ?? "";
  const body = (lang === "ru" ? section.body_ru : section.body_en) ?? "";
  const charts = getCharts(section);
  const useLegacyChartCap = charts.length <= 1;
  const chartCap = useLegacyChartCap
    ? ((lang === "ru" ? section.chart_caption_ru : section.chart_caption_en) ?? (charts[0]?.[lang === "ru" ? "caption_ru" : "caption_en"] ?? ""))
    : "";
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
  if (chartCap) { if (body) lines.push(""); lines.push(`<i>${escapeHtml(chartCap)}</i>`); }
  lines.push("", `· ${partsLabel}`, buildFooter(report, lang));
  return trimCaption(lines.join("\n"));
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
      const cap = buildSectionCaption(section, i, allSections.length, lang, report);
      const charts = getCharts(section);
      let photoStatus = null;
      if (ref.photo_msg_id) {
        photoStatus = charts.length > 0
          ? await tgEditCaption(chatId, ref.photo_msg_id, cap)
          : await tgEditText(chatId, ref.photo_msg_id, cap);
      }
      status.sections.push({ position: section.position, photo: photoStatus });
      await new Promise(r => setTimeout(r, 250));
    }
    out[lang] = status;
  }

  return new Response(JSON.stringify({ ok: true, edit_status: out }), { status: 200, headers: { ...headers, "content-type": "application/json" } });
});

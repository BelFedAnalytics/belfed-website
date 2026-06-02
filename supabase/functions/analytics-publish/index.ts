// analytics-publish v23
// v23: Architectural fix — section charts are now ALWAYS published via multipart upload
//      (download in edge runtime, push as multipart form-data to Telegram).
//      This eliminates the entire class of bugs around Telegram's URL fetch:
//        - WEBPAGE_MEDIA_EMPTY on media groups,
//        - silent reordering / substitution between siblings on the same CDN host,
//        - "wrong type of the web page content" errors.
//      Sub-routes:
//        - charts.length >= 2 → sendMediaGroupMultipart (one album, caption on first photo)
//        - charts.length == 1 → sendPhotoMultipart (single photo, caption attached)
//        - charts.length == 0 → sendMessage (plain text reply to cover)
//      The cover itself still uses URL-based sendPhoto because it carries an inline
//      keyboard ("Open on site") which sendPhoto via multipart in our helper does not
//      currently accept, and the cover has never exhibited the URL-fetch failure mode.
//      Album-then-reply-text fallback is preserved only for the extreme edge case where
//      even the ultra-minimal caption exceeds the 1024-char Telegram limit.
// v22: Reliability hardening for Telegram publishing (retry + delays).
// v21: On first publish, auto-enable email_send_to_premium=true and email_send_at=now().
// v20: Telegram analytics output no longer includes chart captions.
// v19: EN test mode falls back to RU analytics_test DM.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_SECRET = Deno.env.get("BOT_SHARED_SECRET")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const BOT_USERNAME = Deno.env.get("BOT_USERNAME") ?? "BelfedBot";
const SITE_BASE_RU = Deno.env.get("SITE_BASE_RU") ?? "https://belfed.ru";
const SITE_BASE_EN = Deno.env.get("SITE_BASE_EN") ?? "https://belfed.com";

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

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const TG_CAPTION_LIMIT = 1024;
const TG_TEXT_LIMIT = 4096;

// Telegram limit for sendMediaGroup is ~1 group per second per chat.
// 1100ms leaves a small buffer; we keep the same delay for sequential sections.
const DELAY_BETWEEN_SECTIONS_MS = 1100;
const DELAY_BEFORE_MEDIA_GROUP_MS = 1100;
const MAX_RETRIES = 3;

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

function getCharts(section: any) {
  const arr = Array.isArray(section?.chart_images) ? section.chart_images : [];
  const out: any[] = [];
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

function trimCaption(s: string, limit = TG_CAPTION_LIMIT) {
  if (s.length <= limit) return { caption: s, tail: null as string | null };
  const cut = s.lastIndexOf("\n\n", limit - 20);
  if (cut > limit * 0.6) {
    return { caption: s.slice(0, cut) + "\n\n…", tail: s.slice(cut + 2) };
  }
  return { caption: s.slice(0, limit - 20) + "\n…", tail: s.slice(limit - 20) };
}

async function getTopic(lang: string, testMode = false) {
  const key = testMode ? "analytics_test" : "analytics";
  let { data } = await supa
    .from("telegram_topics")
    .select("chat_id, thread_id, is_active")
    .eq("lang", lang)
    .eq("topic_key", key)
    .eq("is_active", true)
    .maybeSingle();
  if (!data && testMode && lang === "en") {
    const fallback = await supa
      .from("telegram_topics")
      .select("chat_id, thread_id, is_active")
      .eq("lang", "ru")
      .eq("topic_key", "analytics_test")
      .eq("is_active", true)
      .maybeSingle();
    data = fallback.data ?? null;
  }
  return data ?? null;
}

// tgFetch wraps Telegram API calls with retry on 429 and network failures.
async function tgFetch(method: string, body: any): Promise<{ ok: boolean; result?: any; error?: string; raw?: any }> {
  let lastError = "unknown";
  let lastRaw: any = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      lastRaw = json;
      if (json.ok) return { ok: true, result: json.result };
      if (res.status === 429 || json.parameters?.retry_after) {
        const retryAfter = (json.parameters?.retry_after ?? 1) * 1000 + 200;
        console.warn(`tg ${method} 429, retry_after=${retryAfter}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(Math.min(retryAfter, 10_000));
        continue;
      }
      lastError = `tg_api_error: ${json.error_code} ${json.description}`;
      console.error(`tg ${method} failed (non-retryable):`, json);
      return { ok: false, error: lastError, raw: json };
    } catch (e) {
      lastError = `network: ${String(e)}`;
      console.warn(`tg ${method} network error (attempt ${attempt + 1}/${MAX_RETRIES}):`, e);
      await sleep(500 * (attempt + 1));
    }
  }
  return { ok: false, error: lastError, raw: lastRaw };
}

// v23: tgFetchMultipart — same retry/backoff semantics, but submits a FormData body.
// We rebuild the FormData on each retry attempt by accepting a builder callback,
// because FormData is single-use in Deno/fetch.
async function tgFetchMultipart(method: string, buildFd: () => FormData): Promise<{ ok: boolean; result?: any; error?: string; raw?: any }> {
  let lastError = "unknown";
  let lastRaw: any = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const fd = buildFd();
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
        method: "POST",
        body: fd,
      });
      const json = await res.json();
      lastRaw = json;
      if (json.ok) return { ok: true, result: json.result };
      if (res.status === 429 || json.parameters?.retry_after) {
        const retryAfter = (json.parameters?.retry_after ?? 1) * 1000 + 200;
        console.warn(`tg ${method} (multipart) 429, retry_after=${retryAfter}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(Math.min(retryAfter, 10_000));
        continue;
      }
      lastError = `tg_api_error: ${json.error_code} ${json.description}`;
      console.error(`tg ${method} (multipart) failed (non-retryable):`, json);
      return { ok: false, error: lastError, raw: json };
    } catch (e) {
      lastError = `network: ${String(e)}`;
      console.warn(`tg ${method} (multipart) network error (attempt ${attempt + 1}/${MAX_RETRIES}):`, e);
      await sleep(500 * (attempt + 1));
    }
  }
  return { ok: false, error: lastError, raw: lastRaw };
}

async function tgSendMessage(chatId: number, threadId: number | null, text: string, replyTo: number | null, replyMarkup: any = null, silent = false) {
  const body: any = { chat_id: chatId, text, disable_web_page_preview: true, parse_mode: "HTML" };
  if (threadId != null) body.message_thread_id = threadId;
  if (replyTo != null) body.reply_to_message_id = replyTo;
  if (replyMarkup) body.reply_markup = replyMarkup;
  if (silent) body.disable_notification = true;
  const r = await tgFetch("sendMessage", body);
  if (!r.ok) return { msg_id: null as number | null, error: r.error };
  return { msg_id: (r.result?.message_id ?? null) as number | null, error: null as string | null };
}

// URL-based sendPhoto — used ONLY for the cover (where we need reply_markup with inline buttons).
async function tgSendPhotoUrl(chatId: number, threadId: number | null, photoUrl: string, caption: string, replyTo: number | null, replyMarkup: any = null, silent = false) {
  const body: any = { chat_id: chatId, photo: photoUrl, caption, parse_mode: "HTML" };
  if (threadId != null) body.message_thread_id = threadId;
  if (replyTo != null) body.reply_to_message_id = replyTo;
  if (replyMarkup) body.reply_markup = replyMarkup;
  if (silent) body.disable_notification = true;
  const r = await tgFetch("sendPhoto", body);
  if (!r.ok) return { msg_id: null as number | null, error: r.error };
  return { msg_id: (r.result?.message_id ?? null) as number | null, error: null as string | null };
}

// v23: Download a photo URL and upload it to Telegram as multipart sendPhoto.
async function tgSendPhotoMultipart(chatId: number, threadId: number | null, photoUrl: string, caption: string, replyTo: number | null, silent = false) {
  let buf: ArrayBuffer;
  let ct = "image/png";
  let filename = "photo.png";
  try {
    const dl = await fetch(photoUrl);
    if (!dl.ok) return { msg_id: null as number | null, error: `download_failed:${dl.status}` };
    buf = await dl.arrayBuffer();
    ct = dl.headers.get("content-type") ?? "image/png";
    filename = (photoUrl.split("/").pop() ?? "photo.png").split("?")[0];
  } catch (e) {
    return { msg_id: null as number | null, error: `download_error:${String(e)}` };
  }

  const buildFd = () => {
    const fd = new FormData();
    fd.append("chat_id", String(chatId));
    if (threadId != null) fd.append("message_thread_id", String(threadId));
    if (replyTo != null) fd.append("reply_to_message_id", String(replyTo));
    if (caption) {
      fd.append("caption", caption);
      fd.append("parse_mode", "HTML");
    }
    if (silent) fd.append("disable_notification", "true");
    fd.append("photo", new Blob([buf], { type: ct }), filename);
    return fd;
  };
  const r = await tgFetchMultipart("sendPhoto", buildFd);
  if (!r.ok) return { msg_id: null as number | null, error: r.error };
  return { msg_id: (r.result?.message_id ?? null) as number | null, error: null as string | null };
}

// v23: Download all photo URLs and upload them to Telegram as a multipart sendMediaGroup.
// This is the ONLY path used for section albums (charts.length >= 2).
async function tgSendMediaGroupMultipart(chatId: number, threadId: number | null, photoUrls: string[], firstCaption: string | null, replyTo: number | null, silent = false) {
  // Cap at Telegram's 10-photo media group limit.
  const urls = photoUrls.slice(0, 10);
  const downloads: { name: string; filename: string; buf: ArrayBuffer; ct: string }[] = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      const dl = await fetch(urls[i]);
      if (!dl.ok) return { msg_id: null as number | null, error: `download_failed_${i}:${dl.status}` };
      const buf = await dl.arrayBuffer();
      const ct = dl.headers.get("content-type") ?? "image/png";
      const filename = (urls[i].split("/").pop() ?? `photo${i}.png`).split("?")[0];
      downloads.push({ name: `photo${i}`, filename, buf, ct });
    } catch (e) {
      return { msg_id: null as number | null, error: `download_error_${i}:${String(e)}` };
    }
  }

  const media = downloads.map((d, i) => {
    const m: any = { type: "photo", media: `attach://${d.name}` };
    if (i === 0 && firstCaption) {
      m.caption = firstCaption;
      m.parse_mode = "HTML";
    }
    return m;
  });

  const buildFd = () => {
    const fd = new FormData();
    fd.append("chat_id", String(chatId));
    if (threadId != null) fd.append("message_thread_id", String(threadId));
    if (replyTo != null) fd.append("reply_to_message_id", String(replyTo));
    if (silent) fd.append("disable_notification", "true");
    fd.append("media", JSON.stringify(media));
    for (const d of downloads) {
      fd.append(d.name, new Blob([d.buf], { type: d.ct }), d.filename);
    }
    return fd;
  };
  const r = await tgFetchMultipart("sendMediaGroup", buildFd);
  if (!r.ok) return { msg_id: null as number | null, error: r.error };
  const arr = r.result;
  const msgId = Array.isArray(arr) && arr.length > 0 ? (arr[0].message_id ?? null) : null;
  return { msg_id: msgId as number | null, error: null as string | null };
}

function escapeHtml(s: string) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtDate(d: string, lang: string) {
  const [y, m, day] = d.split("-");
  const monthsRu = ["янв","фев","мар","апр","май","июн","июл","авг","сен","окт","ноя","дек"];
  const monthsEn = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const months = lang === "ru" ? monthsRu : monthsEn;
  return `${parseInt(day,10)} ${months[parseInt(m,10)-1]} ${y}`;
}

function buildFullFooter(report: any, lang: string) {
  const date = fmtDate(report.report_date, lang);
  const domain = lang === "ru" ? "belfed.ru" : "belfed.com";
  return `· BELFED ANALYTICS · ${date} · @${BOT_USERNAME} · ${domain}`;
}

function buildMiniFooter(partsLabel: string) {
  return `· ${partsLabel}  @${BOT_USERNAME}`;
}

function articleUrlFor(report: any, lang: string) {
  const siteBase = lang === "ru" ? SITE_BASE_RU : SITE_BASE_EN;
  return `${siteBase}/analytics-view.html?slug=${report.slug}`;
}

function buildCoverReplyMarkup(report: any, lang: string) {
  return {
    inline_keyboard: [[
      { text: lang === "ru" ? "📊 Открыть на сайте" : "📊 Open on site", url: articleUrlFor(report, lang) },
    ]],
  };
}

function labelTail(label: string) {
  return label
    .replace(/^[\s·•\-—]*\d+[.)\s]*\s*/u, "")
    .trim();
}

function buildCoverText(report: any, sectionsCount: number, lang: string) {
  const date = fmtDate(report.report_date, lang);
  const title = lang === "ru" ? report.title_ru : (report.title_en ?? report.title_ru);
  const subtitle = lang === "ru" ? report.subtitle_ru : (report.subtitle_en ?? report.subtitle_ru);
  const partsLabel = lang === "ru" ? `Часть 1/${sectionsCount + 1}` : `Part 1/${sectionsCount + 1}`;
  const lines = [`// BELFED ANALYTICS · ${date}`, "", `<b>${escapeHtml(title)}</b>`];
  if (subtitle) lines.push("", escapeHtml(subtitle));
  lines.push("", `· ${partsLabel}`, buildFullFooter(report, lang));
  return lines.join("\n");
}

function buildSectionCaptions(section: any, idx: number, total: number, lang: string, isConclusion: boolean, report: any) {
  const labelRaw = (lang === "ru" ? section.section_label_ru : section.section_label_en) ?? "";
  const label = labelRaw.trim();
  const headlineRaw = (lang === "ru" ? section.headline_ru : section.headline_en) ?? "";
  const body = (lang === "ru" ? section.body_ru : section.body_en) ?? "";
  const charts = getCharts(section);
  const useLegacyChartCap = charts.length <= 1;
  const chartCap = useLegacyChartCap
    ? ((lang === "ru" ? section.chart_caption_ru : section.chart_caption_en) ?? (charts[0]?.[lang === "ru" ? "caption_ru" : "caption_en"] ?? ""))
    : "";
  const partsLabel = isConclusion
    ? (lang === "ru" ? "ГЛАВНЫЙ ВЫВОД" : "KEY TAKEAWAY")
    : (lang === "ru" ? `Часть ${idx + 2}/${total + 1}` : `Part ${idx + 2}/${total + 1}`);

  const labelClean = labelTail(label).toLocaleLowerCase();
  const headlineClean = headlineRaw.trim().toLocaleLowerCase();
  const headline = (headlineClean && headlineClean !== labelClean) ? headlineRaw : "";

  function compose(opts: { includeLabel: boolean; includeChartCap: boolean; includeFullFooter: boolean }) {
    const lines: string[] = [];
    if (opts.includeLabel && label) lines.push(`// ${escapeHtml(label)}`);
    if (headline) lines.push(`<b>${escapeHtml(headline)}</b>`);
    if (lines.length) lines.push("");
    if (body) lines.push(escapeHtml(body));
    if (opts.includeChartCap && chartCap) { if (body) lines.push(""); lines.push(`<i>${escapeHtml(chartCap)}</i>`); }
    lines.push("");
    if (opts.includeFullFooter) {
      lines.push(`· ${partsLabel}`, buildFullFooter(report, lang));
    } else {
      lines.push(buildMiniFooter(partsLabel));
    }
    return lines.join("\n");
  }

  const showFullFooter = !!isConclusion;

  return {
    full:          compose({ includeLabel: true,  includeChartCap: false, includeFullFooter: showFullFooter }),
    compact:       compose({ includeLabel: true,  includeChartCap: false, includeFullFooter: showFullFooter }),
    minimal:       compose({ includeLabel: true,  includeChartCap: false, includeFullFooter: false }),
    ultraMinimal:  compose({ includeLabel: false, includeChartCap: false, includeFullFooter: false }),
    chartCap,
  };
}

// v23: publishes one section. Returns { photo_msg_id, body_msg_id, mode, error }.
// charts >= 2  → multipart sendMediaGroup, caption on first photo
// charts == 1  → multipart sendPhoto, caption attached
// charts == 0  → sendMessage
async function publishSection(
  chatId: number,
  threadId: number | null,
  charts: any[],
  caps: any,
  coverMsgId: number,
  silent: boolean,
): Promise<{ photo_msg_id: number | null; body_msg_id: number | null; mode: string; error: string | null }> {
  let photoMsgId: number | null = null;
  let bodyMsgId: number | null = null;
  let mode = "unknown";
  let lastError: string | null = null;

  // Pick the longest caption variant that fits within 1024 chars.
  const candidates: [string, string][] = [
    [caps.full,         "full"],
    [caps.compact,      "compact"],
    [caps.minimal,      "minimal"],
    [caps.ultraMinimal, "ultra_minimal"],
  ];
  let chosen: string | null = null;
  let chosenVariant = "ultra_minimal";
  for (const [text, m] of candidates) {
    if (text.length <= TG_CAPTION_LIMIT) { chosen = text; chosenVariant = m; break; }
  }

  if (charts.length >= 2) {
    await sleep(DELAY_BEFORE_MEDIA_GROUP_MS);
    const urls = charts.map((c: any) => c.url);

    if (chosen) {
      const r = await tgSendMediaGroupMultipart(chatId, threadId, urls, chosen, coverMsgId, silent);
      photoMsgId = r.msg_id;
      lastError = r.error;
      mode = photoMsgId ? `album_caption_${chosenVariant}` : `album_caption_${chosenVariant}_failed`;
    }

    // Edge case: no caption variant fits, OR media group send failed.
    if (!photoMsgId) {
      const r2 = await tgSendMediaGroupMultipart(chatId, threadId, urls, null, coverMsgId, silent);
      photoMsgId = r2.msg_id;
      if (!photoMsgId) {
        lastError = `${lastError ?? ""};fallback_album_failed:${r2.error}`;
      } else {
        mode = "album_then_reply_text";
        // Only used when caption is too long (>1024). Send the body as reply to the album.
        const { caption: head, tail } = trimCaption(caps.ultraMinimal);
        const replyText = (tail ? head.replace(/\n\n…$/, "") + "\n\n" + tail : head).slice(0, TG_TEXT_LIMIT);
        await sleep(400);
        const rTxt = await tgSendMessage(chatId, threadId, replyText, photoMsgId, null, silent);
        bodyMsgId = rTxt.msg_id;
        if (!bodyMsgId) lastError = `${lastError ?? ""};reply_text_failed:${rTxt.error}`;
      }
    }
  } else if (charts.length === 1) {
    // Single photo. Caption fits or is trimmed; tail (if any) goes as reply.
    const { caption, tail } = trimCaption(caps.full);
    const r = await tgSendPhotoMultipart(chatId, threadId, charts[0].url, caption, coverMsgId, silent);
    photoMsgId = r.msg_id;
    lastError = r.error;
    mode = photoMsgId ? "single_photo_caption" : "single_photo_caption_failed";
    if (tail && photoMsgId) {
      await sleep(400);
      const rTxt = await tgSendMessage(chatId, threadId, tail.slice(0, TG_TEXT_LIMIT), photoMsgId, null, silent);
      bodyMsgId = rTxt.msg_id;
      if (!bodyMsgId) lastError = `${lastError ?? ""};reply_text_failed:${rTxt.error}`;
    }
  } else {
    // No charts at all → text-only section, reply to cover.
    const { caption, tail } = trimCaption(caps.full);
    const r = await tgSendMessage(chatId, threadId, caption, coverMsgId, null, silent);
    photoMsgId = r.msg_id;
    lastError = r.error;
    mode = photoMsgId ? "no_photo_text_only" : "no_photo_text_only_failed";
    if (tail && photoMsgId) {
      await sleep(400);
      const rTxt = await tgSendMessage(chatId, threadId, tail.slice(0, TG_TEXT_LIMIT), photoMsgId, null, silent);
      bodyMsgId = rTxt.msg_id;
      if (!bodyMsgId) lastError = `${lastError ?? ""};reply_text_failed:${rTxt.error}`;
    }
  }

  return { photo_msg_id: photoMsgId, body_msg_id: bodyMsgId, mode, error: lastError };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = cors(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ ok: false, error: "method" }), { status: 405, headers: { ...headers, "content-type": "application/json" } });
  if (req.headers.get("x-bot-secret") !== BOT_SECRET) return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { ...headers, "content-type": "application/json" } });

  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ ok: false, error: "bad_json" }), { status: 400, headers: { ...headers, "content-type": "application/json" } });
  }
  if (!body.report_id) return new Response(JSON.stringify({ ok: false, error: "report_id_required" }), { status: 400, headers: { ...headers, "content-type": "application/json" } });

  const { data: report, error: rErr } = await supa.from("analytics_reports").select("*").eq("id", body.report_id).maybeSingle();
  if (rErr || !report) return new Response(JSON.stringify({ ok: false, error: "report_not_found" }), { status: 404, headers: { ...headers, "content-type": "application/json" } });

  const { data: sections, error: sErr } = await supa.from("analytics_sections").select("*").eq("report_id", body.report_id).order("position", { ascending: true });
  if (sErr) return new Response(JSON.stringify({ ok: false, error: sErr.message }), { status: 500, headers: { ...headers, "content-type": "application/json" } });

  const allSections = sections ?? [];
  const langs = body.langs ?? ["ru", "en"];
  const silent = !!body.silent;
  const results: any = {};

  for (const lang of langs) {
    const topic = await getTopic(lang, !!body.test_mode);
    if (!topic) { results[lang] = { skipped: "no_active_topic" }; continue; }

    const coverReplyMarkup = buildCoverReplyMarkup(report, lang);
    const coverText = buildCoverText(report, allSections.length, lang);

    if (body.dry_run) {
      results[lang] = {
        cover_preview: coverText,
        section_previews: allSections.map((s: any, i: number) => {
          const caps = buildSectionCaptions(s, i, allSections.length, lang, !!s.is_conclusion, report);
          return {
            position: s.position,
            full_len: caps.full.length,
            compact_len: caps.compact.length,
            minimal_len: caps.minimal.length,
            ultra_minimal_len: caps.ultraMinimal.length,
            chart_count: getCharts(s).length,
          };
        }),
      };
      continue;
    }

    // Cover: URL-based so we can include inline keyboard.
    let coverMsgId: number | null = null;
    let coverError: string | null = null;
    if (report.cover_image_url) {
      const r = await tgSendPhotoUrl(topic.chat_id, topic.thread_id, report.cover_image_url, coverText, null, coverReplyMarkup, silent);
      coverMsgId = r.msg_id; coverError = r.error;
    } else {
      const r = await tgSendMessage(topic.chat_id, topic.thread_id, coverText, null, coverReplyMarkup, silent);
      coverMsgId = r.msg_id; coverError = r.error;
    }
    if (!coverMsgId) { results[lang] = { error: "cover_send_failed", tg_error: coverError }; continue; }

    const sectionResults: any[] = [];
    for (let i = 0; i < allSections.length; i++) {
      const section = allSections[i];
      const charts = getCharts(section);
      const caps = buildSectionCaptions(section, i, allSections.length, lang, !!section.is_conclusion, report);

      const out = await publishSection(topic.chat_id, topic.thread_id, charts, caps, coverMsgId, silent);

      const sectionResult: any = {
        section_id: section.id,
        position: section.position,
        photo_msg_id: out.photo_msg_id,
        body_msg_id: out.body_msg_id,
        charts: charts.length,
        mode: out.mode,
      };
      if (out.error) sectionResult.error = out.error;
      sectionResults.push(sectionResult);

      await sleep(DELAY_BETWEEN_SECTIONS_MS);
    }
    results[lang] = { chat_id: topic.chat_id, thread_id: topic.thread_id, cover: coverMsgId, sections: sectionResults };
  }

  if (!body.dry_run) {
    const update: any = {};
    if (results.ru && results.ru.cover) update.tg_message_ids_ru = results.ru;
    if (results.en && results.en.cover) update.tg_message_ids_en = results.en;
    if (report.status !== "published") {
      update.status = "published";
      update.published_at = new Date().toISOString();
      if (report.email_send_to_premium !== false) {
        update.email_send_to_premium = true;
      }
      if (!report.email_send_at) {
        update.email_send_at = new Date().toISOString();
      }
    }
    if (Object.keys(update).length) {
      const { error: upErr } = await supa.from("analytics_reports").update(update).eq("id", body.report_id);
      if (upErr) console.error("update report after publish:", upErr);
    }
  }

  return new Response(JSON.stringify({ ok: true, results }), { status: 200, headers: { ...headers, "content-type": "application/json" } });
});

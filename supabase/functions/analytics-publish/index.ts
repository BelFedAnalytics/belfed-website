// analytics-publish v38
// v38 (2026-09-14): Idempotent publishing.
//   - Incident: the analytics channel received the series three times (one partial run
//     of 7 messages plus two complete runs of 16). The v37 lock is atomic and verified,
//     but it is released when a run ends or fails, so a later retry was free to resend
//     everything. Real publishing is now skipped for a language that already has a
//     stored cover message id; pass force=true to deliberately resend.
//   - test_mode and dry_run are unaffected: tests may be repeated freely.
// analytics-publish v37
// v37 (2026-09-14): Duplicate-publish guard.
//   - A real publish now claims `analytics_reports.tg_publish_lock` atomically before
//     sending anything. A second concurrent request gets 409 publish_in_progress
//     instead of sending the whole series again. Locks older than 5 minutes are
//     reclaimed, and the lock is cleared on success and on error paths.
//   - dry_run never takes the lock.
// analytics-publish v36
// v36 (2026-09-14): Navigator message.
//   - A "СОДЕРЖАНИЕ / CONTENTS" message is sent immediately after the cover, listing
//     every section by its label and headline. It is not counted as a part of the
//     series, so the cover stays 1/N and sections keep 2/N..N/N.
//   - Section links do not exist until the sections are sent, so the navigator goes
//     out as a plain list and is rewritten via editMessageText once all message ids
//     are known. A failed edit leaves the plain list in place and is logged.
// analytics-publish v35
// v35 (2026-09-14): Linked asset analyses are published IN FULL, matching the site.
//   - A section with linked_post_id is no longer collapsed into a cover link. It becomes
//     its own Telegram post: section label, "$TICKER · Company" headline, the analysis
//     body, hashtags, its charts, and a "→ В ЛЕНТЕ / → IN FEED" link to the original.
//   - The numbered link block is gone from the cover, so the report subtitle (the lead
//     paragraph) now fits inside the 1024-char caption instead of being dropped.
//   - Part counter covers every section again: cover is 1/N, sections follow in
//     position order, so labels 01..09 line up with "Часть 2/10".."Часть 10/10".
// analytics-publish v31
// v31 (2026-08-17): Adaptive cover text limit depending on cover image presence.
//   - Reports WITHOUT a cover image are sent via sendMessage (limit 4096 chars),
//     so subtitle + linked block fit in full for typical linked-only reports.
//   - Reports WITH a cover image are still sent via sendPhoto (caption limit 1024)
//     with the same degradation ladder as v30.
//   - pickCoverCaption() now takes hasCoverImage and returns the effective limit.
//   - Dry-run response adds cover_limit and has_cover_image for verification.
// v30 (2026-08-17): Linked sections + autopublish support.
//   - Sections with linked_post_id are NOT published as separate TG messages.
//     Instead they render as a numbered link block appended to the cover caption.
//   - Part counter (Часть N/M / Part N/M) uses ONLY standard (non-linked) sections
//     to stay truthful about "parts you'll actually receive in this feed".
//   - EN degradation: if a linked post has no message_id_en, that link is skipped
//     from the EN cover (with console.warn), other links continue.
//   - Cover caption guard: if the caption exceeds Telegram's 1024-char limit even
//     after trimming subtitle, the link block is posted as a reply message to the
//     cover instead of being embedded in the caption.
//   - Format of a link: <a href="https://t.me/c/<chat_id_no_-100>/<thread_id>/<msg_id>">headline</a>
//     Numbered "1. …" prefix (no introductory phrase per project style).
// v23-v29: chart multipart uploads, retries, delays (unchanged).
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

const LOCK_TTL_MS = 5 * 60 * 1000; // v37: stale publish lock is reclaimed after this
const TG_CAPTION_LIMIT = 1024;
const TG_TEXT_LIMIT = 4096;

const DELAY_BETWEEN_SECTIONS_MS = 1100;
const DELAY_BEFORE_MEDIA_GROUP_MS = 1100;
const MAX_RETRIES = 3;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// Localized charts: an item may carry url_en; EN publishing uses it, RU and fallback use url.
function getCharts(section: any, lang = "ru") {
  const arr = Array.isArray(section?.chart_images) ? section.chart_images : [];
  const out: any[] = [];
  for (const it of arr) {
    if (it && typeof it === "object" && typeof it.url === "string" && it.url) {
      const url = lang === "en" && typeof it.url_en === "string" && it.url_en ? it.url_en : it.url;
      out.push({ url, caption_ru: it.caption_ru, caption_en: it.caption_en });
    }
  }
  if (out.length === 0 && typeof section?.chart_image_url === "string" && section.chart_image_url) {
    out.push({ url: section.chart_image_url, caption_ru: section.chart_caption_ru ?? "", caption_en: section.chart_caption_en ?? "" });
  }
  return out;
}

function trimCaption(s: string, limit = TG_CAPTION_LIMIT) {
  if (s.length <= limit) return { caption: s, tail: null as string | null };
  const cut = s.lastIndexOf("\n\n", limit - 20);
  if (cut > limit * 0.6) return { caption: s.slice(0, cut) + "\n\n…", tail: s.slice(cut + 2) };
  return { caption: s.slice(0, limit - 20) + "\n…", tail: s.slice(limit - 20) };
}

async function getTopic(lang: string, topicKey: string, testMode = false) {
  const key = testMode ? "analytics_test" : topicKey;
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

async function tgFetch(method: string, body: any): Promise<{ ok: boolean; result?: any; error?: string; raw?: any }> {
  let lastError = "unknown"; let lastRaw: any = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const json = await res.json(); lastRaw = json;
      if (json.ok) return { ok: true, result: json.result };
      if (res.status === 429 || json.parameters?.retry_after) {
        const retryAfter = (json.parameters?.retry_after ?? 1) * 1000 + 200;
        console.warn(`tg ${method} 429, retry_after=${retryAfter}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(Math.min(retryAfter, 10_000)); continue;
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

async function tgFetchMultipart(method: string, buildFd: () => FormData): Promise<{ ok: boolean; result?: any; error?: string; raw?: any }> {
  let lastError = "unknown"; let lastRaw: any = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const fd = buildFd();
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", body: fd });
      const json = await res.json(); lastRaw = json;
      if (json.ok) return { ok: true, result: json.result };
      if (res.status === 429 || json.parameters?.retry_after) {
        const retryAfter = (json.parameters?.retry_after ?? 1) * 1000 + 200;
        console.warn(`tg ${method} (multipart) 429, retry_after=${retryAfter}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(Math.min(retryAfter, 10_000)); continue;
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

// v36: used to fill the navigator with real section links once they exist.
async function tgEditMessageText(chatId: number, messageId: number, text: string) {
  const r = await tgFetch("editMessageText", {
    chat_id: chatId, message_id: messageId, text,
    parse_mode: "HTML", disable_web_page_preview: true,
  });
  return { ok: r.ok, error: r.error ?? null };
}

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

async function tgSendPhotoMultipart(chatId: number, threadId: number | null, photoUrl: string, caption: string, replyTo: number | null, silent = false) {
  let buf: ArrayBuffer; let ct = "image/png"; let filename = "photo.png";
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
    if (caption) { fd.append("caption", caption); fd.append("parse_mode", "HTML"); }
    if (silent) fd.append("disable_notification", "true");
    fd.append("photo", new Blob([buf], { type: ct }), filename);
    return fd;
  };
  const r = await tgFetchMultipart("sendPhoto", buildFd);
  if (!r.ok) return { msg_id: null as number | null, error: r.error };
  return { msg_id: (r.result?.message_id ?? null) as number | null, error: null as string | null };
}

async function tgSendMediaGroupMultipart(chatId: number, threadId: number | null, photoUrls: string[], firstCaption: string | null, replyTo: number | null, silent = false) {
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
    if (i === 0 && firstCaption) { m.caption = firstCaption; m.parse_mode = "HTML"; }
    return m;
  });
  const buildFd = () => {
    const fd = new FormData();
    fd.append("chat_id", String(chatId));
    if (threadId != null) fd.append("message_thread_id", String(threadId));
    if (replyTo != null) fd.append("reply_to_message_id", String(replyTo));
    if (silent) fd.append("disable_notification", "true");
    fd.append("media", JSON.stringify(media));
    for (const d of downloads) fd.append(d.name, new Blob([d.buf], { type: d.ct }), d.filename);
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

function buildMiniFooter(partsLabel: string) { return `· ${partsLabel}  @${BOT_USERNAME}`; }

function articleUrlFor(report: any, lang: string) {
  const siteBase = lang === "ru" ? SITE_BASE_RU : SITE_BASE_EN;
  return `${siteBase}/analytics-view.html?slug=${report.slug}`;
}

function buildCoverReplyMarkup(report: any, lang: string) {
  return { inline_keyboard: [[{ text: lang === "ru" ? "📊 Открыть на сайте" : "📊 Open on site", url: articleUrlFor(report, lang) }]] };
}

function labelTail(label: string) {
  return label.replace(/^[\s·•\-—]*\d+[.)\s]*\s*/u, "").trim();
}

// v30: Build a t.me/c/<...> deep link to a specific message inside a supergroup topic.
// chat_id in Telegram supergroups is negative (-100XXXXXXXXXX). The public t.me/c/ URL
// uses the id WITHOUT the -100 prefix. For topics we insert the thread_id path segment.
function buildTgMessageUrl(chatId: number, threadId: number | null, messageId: number): string {
  const absId = String(chatId).replace(/^-100/, "").replace(/^-/, "");
  if (threadId != null) return `https://t.me/c/${absId}/${threadId}/${messageId}`;
  return `https://t.me/c/${absId}/${messageId}`;
}

// v30: split sections into "standard" (published as own TG post) and "linked" (rendered as
// numbered link inside the cover). Preserves original order for both lists.
function partitionSections(sections: any[]): { standard: any[]; linked: any[] } {
  const standard: any[] = []; const linked: any[] = [];
  for (const s of sections ?? []) {
    if (s && s.linked_post_id) linked.push(s); else standard.push(s);
  }
  return { standard, linked };
}

// v30: build the numbered link block for a cover caption. Returns "" when nothing to add.
// EN degradation: silently skips items whose message_id_<lang> is null (with console.warn).
// Format (no introductory phrase per project style):
//   1. <a href="…">Headline one</a>
//   2. <a href="…">Headline two</a>
function buildLinkedBlock(
  linkedSections: any[],
  postsById: Map<string, any>,
  analysisTopic: { chat_id: number; thread_id: number | null } | null,
  lang: string,
): string {
  if (!linkedSections.length || !analysisTopic) return "";
  const lines: string[] = [];
  let counter = 1;
  for (const s of linkedSections) {
    const post = postsById.get(s.linked_post_id);
    if (!post) {
      console.warn(`[analytics-publish v30] linked post ${s.linked_post_id} not found; skipping`);
      continue;
    }
    const msgId = lang === "ru" ? post.message_id_ru : post.message_id_en;
    if (msgId == null) {
      console.warn(`[analytics-publish v30 guard] linked post ${post.slug} has no message_id_${lang}; skipping link in ${lang} cover`);
      continue;
    }
    // v33: asset analyses are published without a headline (the feed labels them by
    // ticker badge + company name). Mirror the site: fall back to "$TICKER · Company".
    const explicit = ((lang === "ru" ? post.headline_ru : post.headline_en) ?? "").trim()
      || ((lang === "ru" ? post.headline_en : post.headline_ru) ?? "").trim();
    const tickerLabel = post.ticker
      ? `$${String(post.ticker).toUpperCase()}${post.company_name ? ` · ${post.company_name}` : ""}`
      : "";
    const headline = explicit || tickerLabel || post.slug;
    const url = buildTgMessageUrl(analysisTopic.chat_id, analysisTopic.thread_id, msgId);
    lines.push(`${counter}. <a href="${escapeHtml(url)}">${escapeHtml(headline)}</a>`);
    counter++;
  }
  return lines.join("\n");
}

// v35: turn a linked section into a full, self-contained Telegram post.
// The section keeps its own label (04, 05, …); everything else comes from the
// analysis post: headline, body, hashtags, charts, and a link back to the feed.
function linkedHeadline(post: any, lang: string): string {
  const explicit = ((lang === "ru" ? post.headline_ru : post.headline_en) ?? "").trim()
    || ((lang === "ru" ? post.headline_en : post.headline_ru) ?? "").trim();
  if (explicit) return explicit;
  if (post.ticker) {
    return `$${String(post.ticker).toUpperCase()}${post.company_name ? ` · ${post.company_name}` : ""}`;
  }
  return post.slug ?? "";
}

function linkedCharts(post: any): any[] {
  const raw = Array.isArray(post?.image_paths) ? post.image_paths : [];
  const out: any[] = [];
  for (const it of raw) {
    let path: string | null = null;
    if (typeof it === "string" && it) path = it;
    else if (it && typeof it === "object" && typeof it.path === "string" && it.path) path = it.path;
    if (!path) continue;
    const url = /^https?:\/\//i.test(path)
      ? path
      : `${SUPABASE_URL}/storage/v1/object/public/analysis-images/${path}`;
    out.push({ url, caption_ru: "", caption_en: "" });
  }
  return out;
}

function materializeLinkedSection(
  section: any,
  post: any,
  analysisTopic: { chat_id: number; thread_id: number | null } | null,
  lang: string,
): any {
  const headline = linkedHeadline(post, lang);
  const bodyRaw = ((lang === "ru" ? post.body_ru : post.body_en) ?? "").trim()
    || ((lang === "ru" ? post.body_en : post.body_ru) ?? "").trim();
  const tags = (post.hashtags ?? "").trim();
  const body = tags ? `${bodyRaw}\n\n${tags}` : bodyRaw;

  let extraHtml = "";
  const msgId = lang === "ru" ? post.message_id_ru : post.message_id_en;
  if (analysisTopic && msgId != null) {
    const url = buildTgMessageUrl(analysisTopic.chat_id, analysisTopic.thread_id, msgId);
    const label = lang === "ru" ? "→ В ЛЕНТЕ" : "→ IN FEED";
    extraHtml = `<a href="${escapeHtml(url)}">${label}</a>`;
  }

  return {
    ...section,
    headline_ru: lang === "ru" ? headline : section.headline_ru,
    headline_en: lang === "en" ? headline : section.headline_en,
    body_ru: lang === "ru" ? body : section.body_ru,
    body_en: lang === "en" ? body : section.body_en,
    chart_images: linkedCharts(post),
    chart_image_url: null,
    extra_html: extraHtml,
    is_conclusion: false,
  };
}

// v36: "содержание" message, sent right after the cover. Links are unknown at send
// time (the sections do not exist yet), so it goes out as a plain list and is edited
// once every section has a message id. Not counted as a part of the series.
function buildNavigator(
  orderedSections: any[],
  lang: string,
  report: any,
  chatId: number | null,
  threadId: number | null,
  msgIdByIndex: (number | null)[] | null,
): string {
  const head = lang === "ru" ? "// СОДЕРЖАНИЕ" : "// CONTENTS";
  const lines: string[] = [];
  for (let i = 0; i < orderedSections.length; i++) {
    const sec = orderedSections[i];
    const labelRaw = ((lang === "ru" ? sec.section_label_ru : sec.section_label_en) ?? "").trim();
    const headlineRaw = ((lang === "ru" ? sec.headline_ru : sec.headline_en) ?? "").trim();
    const name = headlineRaw || labelRaw;
    if (!name) continue;
    const label = labelRaw || String(i + 1);
    const msgId = msgIdByIndex ? msgIdByIndex[i] : null;
    if (msgId != null && chatId != null) {
      const url = buildTgMessageUrl(chatId, threadId, msgId);
      lines.push(`${escapeHtml(label)}. <a href="${escapeHtml(url)}">${escapeHtml(name)}</a>`);
    } else {
      lines.push(`${escapeHtml(label)}. ${escapeHtml(name)}`);
    }
  }
  if (!lines.length) return "";
  return [head, "", lines.join("\n"), "", buildFullFooter(report, lang)].join("\n");
}

// v30: cover text builder that accepts an optional linkedBlock.
// Structure:
//   // BELFED ANALYTICS · <date>
//
//   <b>title</b>
//
//   subtitle (optional)
//
//   <linkedBlock>   ← NEW: numbered link list, no intro phrase
//
//   · Часть 1/N
//   · BELFED ANALYTICS · date · @bot · domain
function buildCoverText(
  report: any,
  standardCount: number,
  lang: string,
  opts: { includeSubtitle?: boolean; linkedBlock?: string } = {},
) {
  const date = fmtDate(report.report_date, lang);
  const title = lang === "ru" ? report.title_ru : (report.title_en ?? report.title_ru);
  const subtitle = lang === "ru" ? report.subtitle_ru : (report.subtitle_en ?? report.subtitle_ru);
  // v35: every section becomes its own post again, so the counter covers all of them.
  const partsLabel = lang === "ru" ? `Часть 1/${standardCount + 1}` : `Part 1/${standardCount + 1}`;

  const lines: string[] = [`// BELFED ANALYTICS · ${date}`, "", `<b>${escapeHtml(title)}</b>`];
  if (opts.includeSubtitle !== false && subtitle) lines.push("", escapeHtml(subtitle));
  if (opts.linkedBlock) lines.push("", opts.linkedBlock);
  lines.push("", `· ${partsLabel}`, buildFullFooter(report, lang));
  return lines.join("\n");
}

// v31: pick the largest cover caption variant that fits Telegram's limit.
// Limit depends on whether the report has a cover image:
//   - hasCoverImage=true  → sendPhoto branch → caption limit 1024.
//   - hasCoverImage=false → sendMessage branch → text limit 4096.
// Degradation order: [with subtitle + linked] → [no subtitle + linked] → [with subtitle, no linked].
// If none fit, the caller will fall back to posting the link block as a reply message.
function pickCoverCaption(report: any, standardCount: number, lang: string, linkedBlock: string, hasCoverImage: boolean): { caption: string; usedLinkedInCaption: boolean; usedSubtitle: boolean; needsReplyLinkBlock: boolean; limit: number } {
  const limit = hasCoverImage ? TG_CAPTION_LIMIT : TG_TEXT_LIMIT;

  // Attempt 1: everything.
  let text = buildCoverText(report, standardCount, lang, { includeSubtitle: true, linkedBlock });
  if (text.length <= limit) return { caption: text, usedLinkedInCaption: !!linkedBlock, usedSubtitle: true, needsReplyLinkBlock: false, limit };

  // Attempt 2: drop subtitle.
  if (linkedBlock) {
    text = buildCoverText(report, standardCount, lang, { includeSubtitle: false, linkedBlock });
    if (text.length <= limit) return { caption: text, usedLinkedInCaption: true, usedSubtitle: false, needsReplyLinkBlock: false, limit };
  }

  // Attempt 3: keep subtitle, drop linked block (will send it as reply).
  text = buildCoverText(report, standardCount, lang, { includeSubtitle: true, linkedBlock: "" });
  if (text.length <= limit) return { caption: text, usedLinkedInCaption: false, usedSubtitle: true, needsReplyLinkBlock: !!linkedBlock, limit };

  // Attempt 4: drop everything optional.
  text = buildCoverText(report, standardCount, lang, { includeSubtitle: false, linkedBlock: "" });
  const { caption } = trimCaption(text, limit);
  return { caption, usedLinkedInCaption: false, usedSubtitle: false, needsReplyLinkBlock: !!linkedBlock, limit };
}

// v30: standard-section captions. Now uses standardIdx / standardTotal, not overall.
function buildSectionCaptions(section: any, standardIdx: number, standardTotal: number, lang: string, isConclusion: boolean, report: any) {
  const labelRaw = (lang === "ru" ? section.section_label_ru : section.section_label_en) ?? "";
  const label = labelRaw.trim();
  const headlineRaw = (lang === "ru" ? section.headline_ru : section.headline_en) ?? "";
  const body = (lang === "ru" ? section.body_ru : section.body_en) ?? "";
  const extraHtml = (section.extra_html ?? "") as string;
  const charts = getCharts(section, lang);
  const partsLabel = isConclusion
    ? (lang === "ru" ? "ГЛАВНЫЙ ВЫВОД" : "KEY TAKEAWAY")
    : (lang === "ru" ? `Часть ${standardIdx + 2}/${standardTotal + 1}` : `Part ${standardIdx + 2}/${standardTotal + 1}`);
  const labelClean = labelTail(label).toLocaleLowerCase();
  const headlineClean = headlineRaw.trim().toLocaleLowerCase();
  const headline = (headlineClean && headlineClean !== labelClean) ? headlineRaw : "";

  function compose(opts: { includeLabel: boolean; includeChartCap: boolean; includeFullFooter: boolean }) {
    const lines: string[] = [];
    if (opts.includeLabel && label) lines.push(`// ${escapeHtml(label)}`);
    if (headline) lines.push(`<b>${escapeHtml(headline)}</b>`);
    if (lines.length) lines.push("");
    if (body) lines.push(escapeHtml(body));
    if (extraHtml) lines.push("", extraHtml);
    lines.push("");
    if (opts.includeFullFooter) lines.push(`· ${partsLabel}`, buildFullFooter(report, lang));
    else lines.push(buildMiniFooter(partsLabel));
    return lines.join("\n");
  }
  const showFullFooter = !!isConclusion;
  return {
    full:          compose({ includeLabel: true,  includeChartCap: false, includeFullFooter: showFullFooter }),
    compact:       compose({ includeLabel: true,  includeChartCap: false, includeFullFooter: showFullFooter }),
    minimal:       compose({ includeLabel: true,  includeChartCap: false, includeFullFooter: false }),
    ultraMinimal:  compose({ includeLabel: false, includeChartCap: false, includeFullFooter: false }),
  };
}

async function publishSection(
  chatId: number, threadId: number | null, charts: any[], caps: any, coverMsgId: number, silent: boolean,
): Promise<{ photo_msg_id: number | null; body_msg_id: number | null; mode: string; error: string | null }> {
  let photoMsgId: number | null = null; let bodyMsgId: number | null = null;
  let mode = "unknown"; let lastError: string | null = null;
  const candidates: [string, string][] = [
    [caps.full, "full"], [caps.compact, "compact"], [caps.minimal, "minimal"], [caps.ultraMinimal, "ultra_minimal"],
  ];
  let chosen: string | null = null; let chosenVariant = "ultra_minimal";
  for (const [text, m] of candidates) {
    if (text.length <= TG_CAPTION_LIMIT) { chosen = text; chosenVariant = m; break; }
  }

  if (charts.length >= 2) {
    await sleep(DELAY_BEFORE_MEDIA_GROUP_MS);
    const urls = charts.map((c: any) => c.url);
    if (chosen) {
      const r = await tgSendMediaGroupMultipart(chatId, threadId, urls, chosen, coverMsgId, silent);
      photoMsgId = r.msg_id; lastError = r.error;
      mode = photoMsgId ? `album_caption_${chosenVariant}` : `album_caption_${chosenVariant}_failed`;
    }
    if (!photoMsgId) {
      const r2 = await tgSendMediaGroupMultipart(chatId, threadId, urls, null, coverMsgId, silent);
      photoMsgId = r2.msg_id;
      if (!photoMsgId) lastError = `${lastError ?? ""};fallback_album_failed:${r2.error}`;
      else {
        mode = "album_then_reply_text";
        const { caption: head, tail } = trimCaption(caps.ultraMinimal);
        const replyText = (tail ? head.replace(/\n\n…$/, "") + "\n\n" + tail : head).slice(0, TG_TEXT_LIMIT);
        await sleep(400);
        const rTxt = await tgSendMessage(chatId, threadId, replyText, photoMsgId, null, silent);
        bodyMsgId = rTxt.msg_id;
        if (!bodyMsgId) lastError = `${lastError ?? ""};reply_text_failed:${rTxt.error}`;
      }
    }
  } else if (charts.length === 1) {
    const { caption, tail } = trimCaption(caps.full);
    const r = await tgSendPhotoMultipart(chatId, threadId, charts[0].url, caption, coverMsgId, silent);
    photoMsgId = r.msg_id; lastError = r.error;
    mode = photoMsgId ? "single_photo_caption" : "single_photo_caption_failed";
    if (tail && photoMsgId) {
      await sleep(400);
      const rTxt = await tgSendMessage(chatId, threadId, tail.slice(0, TG_TEXT_LIMIT), photoMsgId, null, silent);
      bodyMsgId = rTxt.msg_id;
      if (!bodyMsgId) lastError = `${lastError ?? ""};reply_text_failed:${rTxt.error}`;
    }
  } else {
    const { caption, tail } = trimCaption(caps.full);
    const r = await tgSendMessage(chatId, threadId, caption, coverMsgId, null, silent);
    photoMsgId = r.msg_id; lastError = r.error;
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
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ ok: false, error: "bad_json" }), { status: 400, headers: { ...headers, "content-type": "application/json" } }); }
  if (!body.report_id) return new Response(JSON.stringify({ ok: false, error: "report_id_required" }), { status: 400, headers: { ...headers, "content-type": "application/json" } });

  const { data: report, error: rErr } = await supa.from("analytics_reports").select("*").eq("id", body.report_id).maybeSingle();
  if (rErr || !report) return new Response(JSON.stringify({ ok: false, error: "report_not_found" }), { status: 404, headers: { ...headers, "content-type": "application/json" } });

  // v37: atomic claim so a duplicate request cannot send the series twice.
  // Two concurrent invocations (double click, browser retry, overlapping cron) both
  // used to run to completion and the reader got the whole series twice. The update
  // below succeeds for exactly one caller; the loser exits with 409. A stale lock
  // older than LOCK_TTL_MS is reclaimed so a crashed run cannot block publishing.
  const releaseLock = async () => {
    if (body.dry_run) return;
    const { error } = await supa.from("analytics_reports").update({ tg_publish_lock: null }).eq("id", body.report_id);
    if (error) console.error("[analytics-publish v37] lock release failed:", error.message);
  };
  if (!body.dry_run) {
    const cutoff = new Date(Date.now() - LOCK_TTL_MS).toISOString();
    const { data: claimed, error: lockErr } = await supa
      .from("analytics_reports")
      .update({ tg_publish_lock: new Date().toISOString() })
      .eq("id", body.report_id)
      .or(`tg_publish_lock.is.null,tg_publish_lock.lt.${cutoff}`)
      .select("id");
    if (lockErr) {
      // Missing column or transient failure: log and publish anyway rather than block.
      console.error("[analytics-publish v37] lock claim failed, proceeding:", lockErr.message);
    } else if (!claimed || claimed.length === 0) {
      console.warn(`[analytics-publish v37] duplicate publish rejected for ${body.report_id}`);
      return new Response(JSON.stringify({ ok: false, error: "publish_in_progress" }), { status: 409, headers: { ...headers, "content-type": "application/json" } });
    }
  }

  const { data: sections, error: sErr } = await supa.from("analytics_sections").select("*").eq("report_id", body.report_id).order("position", { ascending: true });
  if (sErr) {
    await releaseLock();
    return new Response(JSON.stringify({ ok: false, error: sErr.message }), { status: 500, headers: { ...headers, "content-type": "application/json" } });
  }

  const allSections = sections ?? [];
  // v30: split into linked (link cards in cover) and standard (own TG posts).
  const { standard: standardSections, linked: linkedSections } = partitionSections(allSections);

  // v30: fetch linked post metadata once (used across langs).
  const postsById = new Map<string, any>();
  if (linkedSections.length > 0) {
    const ids = linkedSections.map((s: any) => s.linked_post_id).filter(Boolean);
    if (ids.length > 0) {
      const { data: posts, error: pErr } = await supa
        .from("analysis_posts")
        .select("id, slug, ticker, company_name, destination, headline_ru, headline_en, body_ru, body_en, hashtags, image_paths, status, message_id_ru, message_id_en, publish_to_ru, publish_to_en")
        .in("id", ids);
      if (pErr) {
        console.warn(`[analytics-publish v30] linked post fetch failed: ${pErr.message}`);
      } else {
        for (const p of posts ?? []) postsById.set(p.id, p);
      }
    }
  }

  const langs = body.langs ?? ["ru", "en"];
  const silent = !!body.silent;
  const results: any = {};

  for (const lang of langs) {
    // v38: idempotency. The 5-minute lock only protects against *concurrent* duplicates.
    // A run that failed partway, or a second attempt made minutes later, still resent the
    // whole series into a live channel. A report that already has a cover message id for
    // this language is never sent again unless the caller passes force=true.
    const alreadySent = lang === "ru" ? report.tg_message_ids_ru : report.tg_message_ids_en;
    if (!body.dry_run && !body.test_mode && !body.force && alreadySent && alreadySent.cover) {
      console.warn(`[analytics-publish v38] ${lang}: already published (cover ${alreadySent.cover}), skipping`);
      results[lang] = { skipped: "already_published", cover: alreadySent.cover, chat_id: alreadySent.chat_id ?? null };
      continue;
    }

    const topic = await getTopic(lang, "analytics", !!body.test_mode);
    if (!topic) { results[lang] = { skipped: "no_active_topic" }; continue; }

    // v30: resolve the analysis (timeline posts) topic for THIS lang — used to build
    // t.me/c/<...> links to the linked posts. If missing, link block is empty for this lang.
    const analysisTopic = linkedSections.length > 0
      ? await getTopic(lang, "analysis", !!body.test_mode)
      : null;

    if (linkedSections.length > 0 && !analysisTopic) {
      console.warn(`[analytics-publish v30] no analysis topic for lang=${lang}; linked block will be empty`);
    }

    // v35: linked sections are published in full below, so the cover carries no link
    // block. That frees the caption budget the subtitle needs. buildLinkedBlock is kept
    // for the dry-run preview only.
    const linkedBlock = buildLinkedBlock(linkedSections, postsById, analysisTopic, lang);

    // Publish order follows `position`, so labels 01..09 match Часть 2..10.
    const orderedSections: any[] = [];
    for (const section of allSections) {
      if (!section.linked_post_id) { orderedSections.push(section); continue; }
      const post = postsById.get(section.linked_post_id);
      if (!post) {
        console.warn(`[analytics-publish v35] linked post ${section.linked_post_id} not found; skipping section ${section.position}`);
        continue;
      }
      orderedSections.push(materializeLinkedSection(section, post, analysisTopic, lang));
    }
    const totalSections = orderedSections.length;

    const coverReplyMarkup = buildCoverReplyMarkup(report, lang);
    const coverUrl = report[`cover_image_url_${lang}`] || report.cover_image_url || null;
    const cover = pickCoverCaption(report, totalSections, lang, "", !!coverUrl);

    if (body.dry_run) {
      results[lang] = {
        cover_preview: cover.caption,
        cover_len: cover.caption.length,
        cover_limit: cover.limit,
        has_cover_image: !!coverUrl,
        cover_image_url: coverUrl,
        used_linked_in_caption: cover.usedLinkedInCaption,
        used_subtitle: cover.usedSubtitle,
        needs_reply_link_block: cover.needsReplyLinkBlock,
        navigator_preview: buildNavigator(orderedSections, lang, report, null, null, null),
        linked_block_preview: linkedBlock,
        linked_sections_count: linkedSections.length,
        standard_sections_count: standardSections.length,
        total_sections_count: totalSections,
        section_previews: orderedSections.map((s: any, i: number) => {
          const caps = buildSectionCaptions(s, i, totalSections, lang, !!s.is_conclusion, report);
          return {
            position: s.position,
            linked: !!s.linked_post_id,
            preview: caps.full,
            full_len: caps.full.length, compact_len: caps.compact.length,
            minimal_len: caps.minimal.length, ultra_minimal_len: caps.ultraMinimal.length,
            chart_count: getCharts(s).length,
          };
        }),
      };
      continue;
    }

    // Send cover.
    let coverMsgId: number | null = null; let coverError: string | null = null;
    if (coverUrl) {
      const r = await tgSendPhotoUrl(topic.chat_id, topic.thread_id, coverUrl, cover.caption, null, coverReplyMarkup, silent);
      coverMsgId = r.msg_id; coverError = r.error;
    } else {
      const r = await tgSendMessage(topic.chat_id, topic.thread_id, cover.caption, null, coverReplyMarkup, silent);
      coverMsgId = r.msg_id; coverError = r.error;
    }
    if (!coverMsgId) { results[lang] = { error: "cover_send_failed", tg_error: coverError }; continue; }

    // v30: If link block didn't fit in the caption, send it as a reply message.
    let linkReplyMsgId: number | null = null;
    if (cover.needsReplyLinkBlock && linkedBlock) {
      await sleep(400);
      const r = await tgSendMessage(topic.chat_id, topic.thread_id, linkedBlock, coverMsgId, null, silent);
      linkReplyMsgId = r.msg_id;
      if (!linkReplyMsgId) console.warn(`[analytics-publish v30] link block reply message failed: ${r.error}`);
    }

    // v36: navigator right after the cover, links filled in by an edit at the end.
    let navMsgId: number | null = null;
    const navPlain = buildNavigator(orderedSections, lang, report, null, null, null);
    if (navPlain) {
      await sleep(400);
      const rNav = await tgSendMessage(topic.chat_id, topic.thread_id, navPlain, coverMsgId, null, silent);
      navMsgId = rNav.msg_id;
      if (!navMsgId) console.warn(`[analytics-publish v36] navigator send failed: ${rNav.error}`);
    }

    const sectionResults: any[] = [];
    const sectionMsgIds: (number | null)[] = [];
    // v35: iterate EVERY section, linked ones included, in position order.
    for (let i = 0; i < orderedSections.length; i++) {
      const section = orderedSections[i];
      const charts = getCharts(section, lang);
      const caps = buildSectionCaptions(section, i, totalSections, lang, !!section.is_conclusion, report);
      const out = await publishSection(topic.chat_id, topic.thread_id, charts, caps, coverMsgId, silent);
      const sectionResult: any = {
        section_id: section.id, position: section.position,
        linked: !!section.linked_post_id,
        photo_msg_id: out.photo_msg_id, body_msg_id: out.body_msg_id,
        charts: charts.length, mode: out.mode,
      };
      if (out.error) sectionResult.error = out.error;
      sectionResults.push(sectionResult);
      sectionMsgIds.push(out.photo_msg_id ?? out.body_msg_id ?? null);
      await sleep(DELAY_BETWEEN_SECTIONS_MS);
    }
    // v36: now that every section has a message id, turn the navigator into links.
    let navLinked = false; let navEditError: string | null = null;
    if (navMsgId && sectionMsgIds.some((id) => id != null)) {
      const navFull = buildNavigator(orderedSections, lang, report, topic.chat_id, topic.thread_id, sectionMsgIds);
      if (navFull && navFull !== navPlain) {
        await sleep(400);
        const rEdit = await tgEditMessageText(topic.chat_id, navMsgId, navFull);
        navLinked = rEdit.ok;
        navEditError = rEdit.error;
        if (!rEdit.ok) console.warn(`[analytics-publish v36] navigator edit failed: ${rEdit.error}`);
      }
    }

    results[lang] = {
      chat_id: topic.chat_id,
      thread_id: topic.thread_id,
      cover: coverMsgId,
      nav_msg_id: navMsgId,
      nav_linked: navLinked,
      nav_edit_error: navEditError,
      link_reply_msg_id: linkReplyMsgId,
      linked_count: linkedSections.length,
      sections: sectionResults,
    };
  }

  if (!body.dry_run) {
    const update: any = { tg_publish_lock: null };
    if (results.ru && results.ru.cover) update.tg_message_ids_ru = results.ru;
    if (results.en && results.en.cover) update.tg_message_ids_en = results.en;
    if (report.status !== "published") {
      update.status = "published";
      update.published_at = new Date().toISOString();
      if (report.email_send_to_premium !== false) update.email_send_to_premium = true;
      if (!report.email_send_at) update.email_send_at = new Date().toISOString();
    }
    const { error: upErr } = await supa.from("analytics_reports").update(update).eq("id", body.report_id);
    if (upErr) {
      console.error("update report after publish:", upErr);
      await releaseLock();
    }
  }

  return new Response(JSON.stringify({ ok: true, results }), { status: 200, headers: { ...headers, "content-type": "application/json" } });
});

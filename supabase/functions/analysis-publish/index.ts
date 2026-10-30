// =====================================================================
// analysis-publish — BelFed Asset Analysis & Requests publisher
// v27 — Related post links + larger article galleries (2026-10-30):
//      - New column analysis_posts.related_links jsonb [{url,title_ru,title_en}]
//        (max 10, http/https only). Rendered as a "Связанные посты / Related
//        posts" block before the referral footer in both the regular message
//        and the article. Does not change the web version here.
//      - Article format now accepts up to 50 charts (Telegram limit for media
//        attachments in one rich message). Regular posts stay at 4 because
//        sendMediaGroup is capped to 4 here; more than 4 in a regular post
//        is rejected with too_many_images instead of being silently cut.
// v25 — Upload fallback for images (2026-10-07):
//      - Telegram keeps a negative cache per image URL: once its fetcher fails
//        on a URL ("failed to get HTTP URL content"), every retry of the SAME
//        URL fails instantly, so "Дослать" could never succeed.
//      - sendPhoto / sendMediaGroup now retry once with a multipart upload of
//        the image bytes (downloaded by this function from public storage)
//        when Telegram reports a URL fetch error. Success path is unchanged.
// v21 — Telegram ARTICLE format (sendRichMessage, Bot API 10.2+):
//      - New column analysis_posts.tg_format ('post' | 'article'). When
//        'article', Telegram receives ONE rich message (limit 32768 chars) with
//        the charts embedded inline, so long asset analyses no longer hit the
//        1024-character caption limit.
//      - Layout is the owner-approved "вариант B2": <h3>$TICKER — Company</h3>,
//        body paragraphs, then per chart a plain title line, the image, and a
//        small <figcaption> link "Открыть график в веб-версии", then the
//        referral <footer>, then the hashtags. Empty paragraphs are inserted as
//        spacers between all blocks.
//      - Chart titles and web links come from analysis_posts.image_meta
//        (aligned with image_paths by index); tradingview_url is the fallback
//        link. In article mode tg_text_only is ignored and no photos are
//        attached, because the images live inside the message body.
//      - Applies to publish, republish_missing and edit (edit sends
//        editMessageText with rich_message).
// v20 — Text-only Telegram mode for long posts with images (tg_text_only):
//      - New column analysis_posts.tg_text_only. When true AND the post has
//        images, Telegram receives a plain TEXT message (limit 4096) instead of
//        a photo/album with caption (limit 1024), and a line with clickable
//        links to the images is inserted before the referral footer
//        ("Изображения: 1 · 2" / "Images: 1 · 2").
//      - The website / member area is untouched: image_paths still holds all
//        images, so the web version keeps the full text + images.
//      - Applies to publish, republish_missing and edit (edit uses
//        editMessageText, not editMessageCaption, in this mode).
//      - The flag can also be passed in the request body (tg_text_only) for
//        publish / republish_missing; it is then persisted on the post.
// v15 — Editable referral footer + footer placed before hashtags:
//      - Footer text is now read from config table (keys footer_ru / footer_en),
//        with the previous hardcoded strings as fallback. Stored as PLAIN TEXT;
//        the @BelfedBot token is auto-linked to a clickable HTML <a> here.
//      - Footer is now emitted BEFORE the hashtags block (was last line).
//      - loadFooters() caches both values per invocation; callers await it
//        before buildText(). Applies to BOTH asset & timeline posts.
//      - New admin actions: get_footers / save_footers (same admin auth) so the
//        admin UI can read/persist the footers.
// v14 — Topic routing by destination:
//      - Asset posts (destination="asset") -> "analysis" topic (Asset Analysis)
//      - Timeline & report posts (destination="timeline") -> "analytics" topic
//        (Market Analytics & Reviews). getTopic now takes topicKey via
//        topicKeyFor(p)=isTimeline(p)?"analytics":"analysis". Applies to
//        publish, edit, and delete paths.
// v12 — Headline bold + source italic:
//      - Timeline/Asset headline is now wrapped in <b>…</b> (RU + EN)
//      - Source value is now wrapped in <i>…</i> (label stays plain)
// v10 — Referral footer + HTML parse_mode:
//      - Removed the "Web:/Веб: <permalink>" line from buildText (frees space)
//      - Added a per-language referral footer (last line) with a clickable
//        @BelfedBot link so reshared posts funnel viewers to the bot:
//          RU: · @BelfedBot · belfed.ru · 7 дней бесплатно
//          EN: · @BelfedBot · belfed.com · 7 days free
//      - All TG sends/edits now use parse_mode "HTML"; dynamic content is
//        HTML-escaped (posts contain "&", e.g. "S&P 500"), footer is raw HTML.
// v7 — Timeline destination support (history preserved below)
// =====================================================================

// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const BOT_SHARED_SECRET = Deno.env.get("BOT_SHARED_SECRET")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const WEB_BASE_RU = "https://belfed.ru";
const WEB_BASE_EN = "https://belfed.com";

const BOT_URL = "https://t.me/belfedbot";

const TG_CAPTION_LIMIT = 1024;
const TG_MESSAGE_LIMIT = 4096;
const TG_RICH_LIMIT = 32768;

// Empty paragraph used as a vertical spacer between rich-message blocks.
const RICH_GAP = "<p>&nbsp;</p>";

type Lang = "ru" | "en";

interface AnalysisPost {
  id: string;
  ticker: string | null;
  company_name: string | null;
  post_type: "update" | "request";
  reply_name: string | null;
  reply_text: string | null;
  greeting_ru: string | null;
  greeting_en: string | null;
  body_ru: string | null;
  body_en: string | null;
  tradingview_url: string | null;
  hashtags: string | null;
  image_paths: string[];
  publish_to_ru: boolean;
  publish_to_en: boolean;
  status: string;
  message_id_ru: number | null;
  message_id_en: number | null;
  parent_post_id: string | null;
  slug: string | null;
  published_at: string | null;
  created_at: string;
  destination: string | null;
  headline_ru: string | null;
  headline_en: string | null;
  source: string | null;
  categories: string[] | null;
  tg_text_only: boolean | null;
  tg_format: string | null;
  image_meta: ImageMeta[] | null;
  related_links: RelatedLink[] | null;
}

// One element of analysis_posts.related_links.
interface RelatedLink {
  url?: string | null;
  title_ru?: string | null;
  title_en?: string | null;
}

const MAX_RELATED_LINKS = 10;
const MAX_POST_IMAGES = 4;       // regular post (media group)
const MAX_ARTICLE_IMAGES = 50;   // Telegram: 50 media attachments per rich message

// One element of analysis_posts.image_meta, aligned with image_paths by index.
interface ImageMeta {
  path?: string | null;
  title_ru?: string | null;
  title_en?: string | null;
  tv_url?: string | null;
}

interface Topic { chat_id: number; thread_id: number | null }

interface LangResult {
  lang: Lang;
  ok: boolean;
  message_id?: number | null;
  error?: string;
  length?: number;
  limit?: number;
  excess?: number;
}

function isTimeline(p: AnalysisPost): boolean {
  return (p.destination || "timeline") === "timeline" && !p.ticker;
}

function publicImageUrl(path: string): string {
  const clean = path.replace(/^\/+/, "");
  return `${SUPABASE_URL}/storage/v1/object/public/analysis-images/${clean}`;
}

// True when the post must be delivered to Telegram as a rich message (article).
function isArticle(p: AnalysisPost): boolean {
  return (p.tg_format ?? "post") === "article";
}

// True when the post has images but Telegram must receive a text-only message
// with links to those images instead of a photo/album with a caption.
function tgTextOnly(p: AnalysisPost): boolean {
  if (isArticle(p)) return false; // images live inside the article body
  return p.tg_text_only === true && (p.image_paths ?? []).length > 0;
}

// Image URLs actually attached to the Telegram message (none in text-only mode).
function tgImageUrls(p: AnalysisPost): string[] {
  if (isArticle(p)) return []; // attached inline as <img> instead
  if (tgTextOnly(p)) return [];
  return (p.image_paths ?? []).map(publicImageUrl);
}

// "Изображения: 1 · 2" / "Images: 1 · 2" — clickable links, raw HTML.
function imageLinksLine(p: AnalysisPost, lang: Lang): string {
  const urls = (p.image_paths ?? []).map(publicImageUrl);
  if (urls.length === 0) return "";
  const label = lang === "ru"
    ? (urls.length > 1 ? "Изображения" : "Изображение")
    : (urls.length > 1 ? "Images" : "Image");
  if (urls.length === 1) {
    const word = lang === "ru" ? "открыть" : "open";
    return `${label}: <a href="${urls[0]}">${word}</a>`;
  }
  const links = urls.map((u, i) => `<a href="${u}">${i + 1}</a>`).join(" · ");
  return `${label}: ${links}`;
}

// Valid related links for a post: http(s) only, capped, with language titles.
function relatedItems(p: AnalysisPost, lang: Lang): Array<{ url: string; title: string }> {
  const raw = Array.isArray(p.related_links) ? p.related_links : [];
  const out: Array<{ url: string; title: string }> = [];
  for (const r of raw) {
    const url = String(r?.url ?? "").trim();
    if (!/^https?:\/\/\S+$/i.test(url)) continue;
    const t = String((lang === "ru" ? r?.title_ru : r?.title_en) ?? "").trim();
    out.push({ url, title: t });
    if (out.length >= MAX_RELATED_LINKS) break;
  }
  return out;
}

// "Связанные посты:" + bullet list of clickable links (raw HTML, escaped parts).
function relatedBlock(p: AnalysisPost, lang: Lang, br: string): string {
  const items = relatedItems(p, lang);
  if (items.length === 0) return "";
  const label = lang === "ru" ? "Связанные посты" : "Related posts";
  const word = lang === "ru" ? "Пост" : "Post";
  const lines = items.map((it, i) =>
    `• <a href="${escapeHtml(it.url)}">${escapeHtml(it.title || `${word} ${i + 1}`)}</a>`);
  return `${label}:${br}${lines.join(br)}`;
}

// Validation of image counts per format. Returns an error code or null.
function imageCountError(p: AnalysisPost): string | null {
  const n = (p.image_paths ?? []).length;
  if (isArticle(p)) return n > MAX_ARTICLE_IMAGES ? "too_many_images" : null;
  if (tgTextOnly(p)) return null;
  return n > MAX_POST_IMAGES ? "too_many_images" : null;
}

// Escape text for Telegram HTML parse_mode. Only & < > are special.
function escapeHtml(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Hardcoded fallbacks (plain text) used only if config rows are missing.
const FOOTER_FALLBACK: Record<Lang, string> = {
  ru: "· @BelfedBot · belfed.ru · 14 дней бесплатно",
  en: "· @BelfedBot · belfed.com · 14 days free",
};

// Per-invocation cache of the plain-text footers loaded from config.
let footerCache: Record<Lang, string> | null = null;

// Read footer_ru / footer_en from the config table (service role, bypasses RLS).
// Falls back to FOOTER_FALLBACK for any missing/empty value. Cached per cold call.
async function loadFooters(): Promise<Record<Lang, string>> {
  if (footerCache) return footerCache;
  const cache: Record<Lang, string> = { ru: FOOTER_FALLBACK.ru, en: FOOTER_FALLBACK.en };
  try {
    const { data } = await supabase
      .from("config")
      .select("key, value")
      .in("key", ["footer_ru", "footer_en"]);
    for (const row of (data ?? []) as Array<{ key: string; value: string }>) {
      const v = (row.value ?? "").trim();
      if (!v) continue;
      if (row.key === "footer_ru") cache.ru = v;
      else if (row.key === "footer_en") cache.en = v;
    }
  } catch (e) { console.error("loadFooters:", e); }
  footerCache = cache;
  return cache;
}

// Build the per-language referral footer as raw HTML. Input is the plain-text
// footer; the literal "@BelfedBot" token is turned into a clickable <a> link.
// The rest of the footer is HTML-escaped so user-edited text is safe.
function referralFooter(lang: Lang): string {
  const raw = (footerCache?.[lang] ?? FOOTER_FALLBACK[lang]);
  const parts = raw.split("@BelfedBot");
  if (parts.length === 1) return escapeHtml(raw);
  const link = `<a href="${BOT_URL}">@BelfedBot</a>`;
  return parts.map(escapeHtml).join(link);
}

// Build the Telegram message as HTML. All dynamic (post-author) content is
// HTML-escaped; the referral footer is appended as raw HTML.
function buildText(p: AnalysisPost, lang: Lang): string {
  const lines: string[] = [];
  const greeting = lang === "ru" ? p.greeting_ru : p.greeting_en;
  const body     = lang === "ru" ? p.body_ru     : p.body_en;

  if (isTimeline(p)) {
    const headline = (lang === "ru" ? p.headline_ru : p.headline_en) || p.headline_en || p.headline_ru;
    if (headline && headline.trim()) {
      lines.push(`<b>${escapeHtml(headline.trim())}</b>`);
      lines.push("");
    }
  } else {
    const head = p.company_name
      ? `$${(p.ticker || "").toUpperCase()} — ${p.company_name}`
      : `$${(p.ticker || "").toUpperCase()}`;
    lines.push(`<b>${escapeHtml(head)}</b>`);
    lines.push("");
  }

  if (greeting && greeting.trim()) {
    lines.push(escapeHtml(greeting.trim()));
    lines.push("");
  }

  if (body && body.trim()) {
    lines.push(escapeHtml(body.trim()));
    lines.push("");
  }

  if (isTimeline(p) && p.source && p.source.trim()) {
    const label = lang === "ru" ? "Источник" : "Source";
    lines.push(`${label}: <i>${escapeHtml(p.source.trim())}</i>`);
    lines.push("");
  }

  if (p.tradingview_url && p.tradingview_url.trim()) {
    const label = lang === "ru" ? "График" : "Chart";
    lines.push(`${label}: ${escapeHtml(p.tradingview_url.trim())}`);
    lines.push("");
  }

  // Text-only mode: links to the images that are not attached to the message.
  if (tgTextOnly(p)) {
    const line = imageLinksLine(p, lang);
    if (line) { lines.push(line); lines.push(""); }
  }

  const rel = relatedBlock(p, lang, "\n");
  if (rel) { lines.push(rel); lines.push(""); }

  // Referral footer — placed BEFORE the hashtags block (raw HTML, auto-linked).
  lines.push(referralFooter(lang));
  lines.push("");

  if (p.hashtags && p.hashtags.trim()) {
    lines.push(escapeHtml(p.hashtags.trim()));
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------------
// Article (rich message) rendering — owner-approved layout "вариант B2".
// ---------------------------------------------------------------------

// Plain text with blank-line separated paragraphs -> <p> blocks joined by an
// empty paragraph, so Telegram renders a visible gap between them.
function richParas(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => `<p>${escapeHtml(b).split("\n").join("<br>")}</p>`)
    .join(RICH_GAP);
}

// One chart block: title line, the image, then the small "open in the web
// version" link rendered as a figcaption.
function richChartBlock(imageUrl: string, title: string, webUrl: string, lang: Lang): string {
  const label = lang === "ru" ? "Открыть график в веб-версии" : "Open the chart in the web version";
  const cap = webUrl ? `<figcaption><a href="${escapeHtml(webUrl)}">${label}</a></figcaption>` : "";
  const head = title ? `<p>${escapeHtml(title)}</p>` : "";
  return `${head}<figure><img src="${imageUrl}"/>${cap}</figure>`;
}

// Build the full rich-message HTML for one language.
function buildRich(p: AnalysisPost, lang: Lang): string {
  const out: string[] = [];

  if (isTimeline(p)) {
    const headline = (lang === "ru" ? p.headline_ru : p.headline_en) || p.headline_en || p.headline_ru;
    if (headline && headline.trim()) out.push(`<h3>${escapeHtml(headline.trim())}</h3>`);
  } else {
    const head = p.company_name
      ? `$${(p.ticker || "").toUpperCase()} — ${p.company_name}`
      : `$${(p.ticker || "").toUpperCase()}`;
    out.push(`<h3>${escapeHtml(head)}</h3>`);
  }

  const greeting = lang === "ru" ? p.greeting_ru : p.greeting_en;
  if (greeting && greeting.trim()) out.push(richParas(greeting.trim()));

  const body = lang === "ru" ? p.body_ru : p.body_en;
  if (body && body.trim()) out.push(richParas(body.trim()));

  if (isTimeline(p) && p.source && p.source.trim()) {
    const label = lang === "ru" ? "Источник" : "Source";
    out.push(RICH_GAP + `<p>${label}: <i>${escapeHtml(p.source.trim())}</i></p>`);
  }

  const paths = p.image_paths ?? [];
  const meta = Array.isArray(p.image_meta) ? p.image_meta : [];
  const fallbackUrl = (p.tradingview_url ?? "").trim();
  const charts = paths.map((path, i) => {
    const m = meta.find((x) => x && x.path === path) ?? meta[i] ?? {};
    const title = String((lang === "ru" ? m.title_ru : m.title_en) ?? "").trim();
    const webUrl = String(m.tv_url ?? "").trim() || fallbackUrl;
    return richChartBlock(publicImageUrl(path), title, webUrl, lang);
  });
  if (charts.length) out.push(RICH_GAP + charts.join(RICH_GAP));

  const relRich = relatedBlock(p, lang, "<br>");
  if (relRich) out.push(RICH_GAP + `<p>${relRich}</p>`);

  out.push(RICH_GAP + `<footer>${referralFooter(lang)}</footer>`);

  if (p.hashtags && p.hashtags.trim()) {
    out.push(RICH_GAP + `<p>${escapeHtml(p.hashtags.trim())}</p>`);
  }

  return out.join("");
}

// Length guard for article mode: Telegram counts 32768 characters.
function checkRichLength(html: string): { ok: true } | { ok: false; length: number; limit: number; excess: number } {
  const len = [...html].length;
  if (len > TG_RICH_LIMIT) return { ok: false, length: len, limit: TG_RICH_LIMIT, excess: len - TG_RICH_LIMIT };
  return { ok: true };
}

// Per-language preflight that picks the right builder and limit for the post.
function preflightLang(p: AnalysisPost, lang: Lang, imageCount: number): LangResult | null {
  if (isArticle(p)) {
    const c = checkRichLength(buildRich(p, lang));
    if (!c.ok) return { lang, ok: false, error: "article_too_long", length: c.length, limit: c.limit, excess: c.excess };
    return null;
  }
  const c = checkLength(buildText(p, lang), imageCount);
  if (!c.ok) return { lang, ok: false, error: "caption_too_long", length: c.length, limit: c.limit, excess: c.excess };
  return null;
}

function captionLimitForImages(imageCount: number): number {
  return imageCount > 0 ? TG_CAPTION_LIMIT : TG_MESSAGE_LIMIT;
}

function checkLength(text: string, imageCount: number): { ok: true } | { ok: false; length: number; limit: number; excess: number } {
  const limit = captionLimitForImages(imageCount);
  const len = text.length;
  if (len > limit) return { ok: false, length: len, limit, excess: len - limit };
  return { ok: true };
}

// Route by destination: asset posts -> "analysis" (Asset Analysis topic);
// timeline & report posts -> "analytics" (Market Analytics & Reviews topic).
function topicKeyFor(p: AnalysisPost): string {
  return isTimeline(p) ? "analytics" : "analysis";
}

async function getTopic(lang: Lang, topicKey: string): Promise<Topic | null> {
  const { data } = await supabase
    .from("telegram_topics")
    .select("chat_id, thread_id")
    .eq("lang", lang)
    .eq("topic_key", topicKey)
    .eq("is_active", true)
    .single();
  return (data as Topic) ?? null;
}

async function loadPost(postId: string): Promise<AnalysisPost | null> {
  const { data, error } = await supabase
    .from("analysis_posts")
    .select("*")
    .eq("id", postId)
    .single();
  if (error) { console.error("loadPost", error); return null; }
  const ip = (data as any).image_paths;
  const norm = Array.isArray(ip) ? ip : [];
  return { ...(data as any), image_paths: norm } as AnalysisPost;
}

function slugifyText(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "");
}

async function ensureSlug(p: AnalysisPost): Promise<string> {
  if (p.slug && p.slug.trim()) return p.slug;
  let stem = "";
  if (p.ticker && p.ticker.trim()) {
    stem = (p.ticker || "post").toLowerCase().replace(/[^a-z0-9]/g, "");
  } else {
    stem = slugifyText(p.headline_en || p.headline_ru || "post") || "post";
  }
  const d = new Date(p.published_at || new Date().toISOString());
  const ymd = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  const base = `${stem}-${ymd}`;
  const { data: hits } = await supabase
    .from("analysis_posts")
    .select("slug")
    .like("slug", `${base}%`);
  const existing = new Set((hits ?? []).map((r: any) => r.slug).filter(Boolean));
  let candidate = base;
  let n = 1;
  while (existing.has(candidate)) { n += 1; candidate = `${base}-${n}`; }
  const { error } = await supabase
    .from("analysis_posts")
    .update({ slug: candidate })
    .eq("id", p.id);
  if (error) console.error("ensureSlug update failed:", error);
  p.slug = candidate;
  return candidate;
}

async function getParentMessageId(parentId: string, lang: Lang): Promise<number | null> {
  const { data, error } = await supabase
    .from("analysis_posts")
    .select("message_id_ru, message_id_en, status")
    .eq("id", parentId)
    .maybeSingle();
  if (error || !data) { console.error("getParentMessageId:", error); return null; }
  if (data.status !== "published") return null;
  return (lang === "ru" ? data.message_id_ru : data.message_id_en) ?? null;
}

async function tgCall(method: string, body: any) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: any;
  try { json = await res.json(); } catch { json = {}; }
  return { ok: !!json.ok, payload: json };
}

// Telegram errors that mean "could not fetch the file by URL". Telegram caches
// such failures per URL, so retrying the same URL is pointless.
function isUrlFetchError(desc: unknown): boolean {
  return /failed to get http url content|wrong file identifier\/http url specified|wrong type of the web page content/i
    .test(String(desc ?? ""));
}

async function fetchImageBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch ${res.status} for ${url}`);
  return await res.blob();
}

function fileNameFromUrl(url: string, idx: number): string {
  const tail = url.split("?")[0].split("/").pop() || `image_${idx}.png`;
  return tail.replace(/[^A-Za-z0-9._-]/g, "_");
}

// Multipart call (files uploaded directly instead of being fetched by Telegram).
async function tgCallMultipart(method: string, fields: Record<string, unknown>, files: Array<{ field: string; url: string; idx: number }>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    fd.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  for (const f of files) {
    const blob = await fetchImageBlob(f.url);
    fd.append(f.field, blob, fileNameFromUrl(f.url, f.idx));
  }
  const res = await fetch(`${TG_API}/${method}`, { method: "POST", body: fd });
  let json: any;
  try { json = await res.json(); } catch { json = {}; }
  return { ok: !!json.ok, payload: json };
}

async function tgPublish(
  chatId: number,
  threadId: number | null,
  text: string,
  imageUrls: string[],
  replyTo: number | null,
): Promise<{ ok: true; message_id: number | null } | { ok: false; error: string }> {
  const baseThread = threadId != null ? { message_thread_id: threadId } : {};
  const replyParams = replyTo != null
    ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
    : {};

  if (imageUrls.length === 0) {
    const { ok, payload } = await tgCall("sendMessage", {
      chat_id: chatId, ...baseThread, ...replyParams,
      text, parse_mode: "HTML", disable_web_page_preview: true,
    });
    if (!ok) { console.error("sendMessage", payload); return { ok: false, error: `sendMessage: ${payload?.error_code ?? "?"} ${payload?.description ?? "failed"}` }; }
    return { ok: true, message_id: payload.result?.message_id ?? null };
  }

  if (imageUrls.length === 1) {
    let { ok, payload } = await tgCall("sendPhoto", {
      chat_id: chatId, ...baseThread, ...replyParams,
      photo: imageUrls[0], caption: text, parse_mode: "HTML",
    });
    if (!ok && isUrlFetchError(payload?.description)) {
      console.warn("sendPhoto by URL failed, retrying with upload:", payload?.description);
      try {
        ({ ok, payload } = await tgCallMultipart("sendPhoto", {
          chat_id: chatId, ...baseThread, ...replyParams, caption: text, parse_mode: "HTML",
        }, [{ field: "photo", url: imageUrls[0], idx: 0 }]));
      } catch (e) { console.error("sendPhoto upload fallback:", e); }
    }
    if (!ok) { console.error("sendPhoto", payload); return { ok: false, error: `sendPhoto: ${payload?.error_code ?? "?"} ${payload?.description ?? "failed"}` }; }
    return { ok: true, message_id: payload.result?.message_id ?? null };
  }

  const media = imageUrls.slice(0, 4).map((url, idx) => ({
    type: "photo", media: url,
    ...(idx === 0 ? { caption: text, parse_mode: "HTML" } : {}),
  }));
  let { ok, payload } = await tgCall("sendMediaGroup", {
    chat_id: chatId, ...baseThread, ...replyParams, media,
  });
  if (!ok && isUrlFetchError(payload?.description)) {
    console.warn("sendMediaGroup by URL failed, retrying with upload:", payload?.description);
    try {
      const urls = imageUrls.slice(0, 4);
      const mediaUp = urls.map((_u, idx) => ({
        type: "photo", media: `attach://file${idx}`,
        ...(idx === 0 ? { caption: text, parse_mode: "HTML" } : {}),
      }));
      ({ ok, payload } = await tgCallMultipart("sendMediaGroup", {
        chat_id: chatId, ...baseThread, ...replyParams, media: mediaUp,
      }, urls.map((u, idx) => ({ field: `file${idx}`, url: u, idx }))));
    } catch (e) { console.error("sendMediaGroup upload fallback:", e); }
  }
  if (!ok) { console.error("sendMediaGroup", payload); return { ok: false, error: `sendMediaGroup: ${payload?.error_code ?? "?"} ${payload?.description ?? "failed"}` }; }
  const msgs = payload.result ?? [];
  const firstId = msgs[0]?.message_id ?? null;
  return { ok: true, message_id: firstId };
}

// Send the post as ONE rich message (article). Images are already inside html.
async function tgPublishRich(
  chatId: number,
  threadId: number | null,
  html: string,
  replyTo: number | null,
): Promise<{ ok: true; message_id: number | null } | { ok: false; error: string }> {
  const { ok, payload } = await tgCall("sendRichMessage", {
    chat_id: chatId,
    ...(threadId != null ? { message_thread_id: threadId } : {}),
    ...(replyTo != null ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    rich_message: { html },
  });
  if (!ok) {
    console.error("sendRichMessage", payload);
    return { ok: false, error: `sendRichMessage: ${payload?.error_code ?? "?"} ${payload?.description ?? "failed"}` };
  }
  return { ok: true, message_id: payload.result?.message_id ?? null };
}

// Replace the content of a published rich message (article mode).
async function tgEditRich(chatId: number, messageId: number, html: string): Promise<"ok" | "stale" | "error"> {
  const { ok, payload } = await tgCall("editMessageText", {
    chat_id: chatId, message_id: messageId, rich_message: { html },
  });
  if (ok) return "ok";
  const desc = String(payload?.description ?? "").toLowerCase();
  if (desc.includes("can't be edited") || desc.includes("not found") || desc.includes("not modified")) return "stale";
  console.error("tgEditRich error:", payload);
  return "error";
}

async function tgEditMessage(
  chatId: number, messageId: number, newText: string, isMedia: boolean,
): Promise<"ok" | "stale" | "error"> {
  const method = isMedia ? "editMessageCaption" : "editMessageText";
  const body: any = isMedia
    ? { chat_id: chatId, message_id: messageId, caption: newText, parse_mode: "HTML" }
    : { chat_id: chatId, message_id: messageId, text: newText, parse_mode: "HTML", disable_web_page_preview: true };
  const { ok, payload } = await tgCall(method, body);
  if (ok) return "ok";
  const desc = String(payload?.description ?? "").toLowerCase();
  if (desc.includes("can't be edited") || desc.includes("not found") || desc.includes("not modified")) return "stale";
  console.error("tgEdit error:", payload);
  return "error";
}

async function tgDeleteMessage(chatId: number, messageId: number): Promise<boolean> {
  const { ok } = await tgCall("deleteMessage", { chat_id: chatId, message_id: messageId });
  return ok;
}

async function sendOneLang(p: AnalysisPost, lang: Lang, imageUrls: string[]): Promise<LangResult> {
  const topic = await getTopic(lang, topicKeyFor(p));
  if (!topic) return { lang, ok: false, error: `topic_${lang}_not_configured` };

  const pre = preflightLang(p, lang, imageUrls.length);
  if (pre) return pre;

  let replyTo: number | null = null;
  if (p.parent_post_id) replyTo = await getParentMessageId(p.parent_post_id, lang);

  if (isArticle(p)) {
    const sentRich = await tgPublishRich(topic.chat_id, topic.thread_id, buildRich(p, lang), replyTo);
    if (!sentRich.ok) return { lang, ok: false, error: sentRich.error };
    return { lang, ok: true, message_id: sentRich.message_id };
  }

  const text = buildText(p, lang);
  const sent = await tgPublish(topic.chat_id, topic.thread_id, text, imageUrls, replyTo);
  if (!sent.ok) return { lang, ok: false, error: sent.error };
  return { lang, ok: true, message_id: sent.message_id };
}

// Persist an explicit tg_text_only override coming from the admin UI.
async function applyTextOnlyOverride(postId: string, override: unknown): Promise<void> {
  if (typeof override !== "boolean") return;
  const { error } = await supabase
    .from("analysis_posts")
    .update({ tg_text_only: override })
    .eq("id", postId);
  if (error) console.error("applyTextOnlyOverride:", error);
}

async function actionPublish(postId: string, textOnlyOverride?: unknown) {
  await applyTextOnlyOverride(postId, textOnlyOverride);
  let p = await loadPost(postId);
  if (!p) return { error: "post_not_found" };
  if (p.status === "published") return { error: "already_published" };

  await ensureSlug(p);
  { const ce = imageCountError(p); if (ce) return { error: ce, hint: isArticle(p) ? "В статье не больше 50 графиков." : "В обычном посте не больше 4 графиков: удалите лишние или переключите формат на статью." }; }
  await loadFooters();

  const imageUrls = tgImageUrls(p);

  const preflight: LangResult[] = [];
  if (p.publish_to_ru) { const f = preflightLang(p, "ru", imageUrls.length); if (f) preflight.push(f); }
  if (p.publish_to_en) { const f = preflightLang(p, "en", imageUrls.length); if (f) preflight.push(f); }
  if (preflight.length > 0) {
    return {
      error: preflight[0].error,
      failures: preflight,
      hint: isArticle(p)
        ? "Сократите текст до отправки. Лимит статьи — 32768 символов."
        : "Сократите текст до отправки. Лимит подписи к фото — 1024 символа, текстового сообщения без фото — 4096.",
    };
  }

  const results: LangResult[] = [];
  if (p.publish_to_ru) results.push(await sendOneLang(p, "ru", imageUrls));
  if (p.publish_to_en) results.push(await sendOneLang(p, "en", imageUrls));

  const ru = results.find(r => r.lang === "ru");
  const en = results.find(r => r.lang === "en");
  const allOk = results.every(r => r.ok);
  const ruMid = ru?.ok ? (ru.message_id ?? null) : null;
  const enMid = en?.ok ? (en.message_id ?? null) : null;

  const update: any = { message_id_ru: ruMid, message_id_en: enMid };
  if (allOk) {
    update.status = "published";
    update.published_at = new Date().toISOString();
  }
  const { error } = await supabase.from("analysis_posts").update(update).eq("id", postId);
  if (error) console.error("update on publish:", error);

  if (!allOk) {
    return {
      error: "partial_failure",
      failures: results.filter(r => !r.ok),
      successes: results.filter(r => r.ok),
      message_id_ru: ruMid, message_id_en: enMid, slug: p.slug,
      hint: "Часть языков не опубликована. Используйте republish_missing после правки.",
    };
  }
  return { ok: true, message_id_ru: ruMid, message_id_en: enMid, slug: p.slug };
}

async function actionRepublishMissing(postId: string, textOnlyOverride?: unknown) {
  await applyTextOnlyOverride(postId, textOnlyOverride);
  let p = await loadPost(postId);
  if (!p) return { error: "post_not_found" };
  await ensureSlug(p);
  { const ce = imageCountError(p); if (ce) return { error: ce, hint: isArticle(p) ? "В статье не больше 50 графиков." : "В обычном посте не больше 4 графиков: удалите лишние или переключите формат на статью." }; }
  await loadFooters();

  const needRu = p.publish_to_ru && !p.message_id_ru;
  const needEn = p.publish_to_en && !p.message_id_en;
  if (!needRu && !needEn) return { error: "nothing_missing", hint: "Все запрошенные языки уже опубликованы." };

  const imageUrls = tgImageUrls(p);

  const preflight: LangResult[] = [];
  if (needRu) { const f = preflightLang(p, "ru", imageUrls.length); if (f) preflight.push(f); }
  if (needEn) { const f = preflightLang(p, "en", imageUrls.length); if (f) preflight.push(f); }
  if (preflight.length > 0) {
    return {
      error: preflight[0].error,
      failures: preflight,
      hint: isArticle(p)
        ? "Сократите текст до отправки. Лимит статьи — 32768 символов."
        : "Сократите текст до отправки. Лимит подписи к фото — 1024 символа.",
    };
  }

  const results: LangResult[] = [];
  if (needRu) results.push(await sendOneLang(p, "ru", imageUrls));
  if (needEn) results.push(await sendOneLang(p, "en", imageUrls));

  const ru = results.find(r => r.lang === "ru");
  const en = results.find(r => r.lang === "en");

  const update: any = {};
  if (ru?.ok && ru.message_id != null) update.message_id_ru = ru.message_id;
  if (en?.ok && en.message_id != null) update.message_id_en = en.message_id;

  const finalRu = update.message_id_ru ?? p.message_id_ru;
  const finalEn = update.message_id_en ?? p.message_id_en;
  const ruSatisfied = !p.publish_to_ru || finalRu != null;
  const enSatisfied = !p.publish_to_en || finalEn != null;
  const allSatisfied = ruSatisfied && enSatisfied;

  if (allSatisfied && p.status !== "published") {
    update.status = "published";
    if (!p.published_at) update.published_at = new Date().toISOString();
  }

  if (Object.keys(update).length > 0) {
    const { error } = await supabase.from("analysis_posts").update(update).eq("id", postId);
    if (error) console.error("update on republish_missing:", error);
  }

  const failures = results.filter(r => !r.ok);
  if (failures.length > 0) {
    return {
      error: "partial_failure", failures,
      successes: results.filter(r => r.ok),
      message_id_ru: finalRu, message_id_en: finalEn, slug: p.slug,
    };
  }
  return { ok: true, message_id_ru: finalRu, message_id_en: finalEn, slug: p.slug, sent: results.map(r => r.lang) };
}

async function actionEdit(postId: string) {
  const p = await loadPost(postId);
  if (!p) return { error: "post_not_found" };
  if (p.status !== "published") return { error: "not_published" };
  await ensureSlug(p);
  await loadFooters();

  const article = isArticle(p);
  const isMedia = !article && !tgTextOnly(p) && (p.image_paths ?? []).length > 0;
  const results: Record<string, any> = {};

  const preflight: LangResult[] = [];
  if (p.message_id_ru) { const f = preflightLang(p, "ru", isMedia ? 1 : 0); if (f) preflight.push(f); }
  if (p.message_id_en) { const f = preflightLang(p, "en", isMedia ? 1 : 0); if (f) preflight.push(f); }
  if (preflight.length > 0) {
    return {
      error: preflight[0].error,
      failures: preflight,
      hint: article ? "Сократите текст. Лимит статьи — 32768 символов." : "Сократите текст. Лимит подписи к фото — 1024 символа.",
    };
  }

  if (p.message_id_ru) {
    const topic = await getTopic("ru", topicKeyFor(p));
    if (topic) {
      results.ru = article
        ? await tgEditRich(topic.chat_id, p.message_id_ru, buildRich(p, "ru"))
        : await tgEditMessage(topic.chat_id, p.message_id_ru, buildText(p, "ru"), isMedia);
    }
  }
  if (p.message_id_en) {
    const topic = await getTopic("en", topicKeyFor(p));
    if (topic) {
      results.en = article
        ? await tgEditRich(topic.chat_id, p.message_id_en, buildRich(p, "en"))
        : await tgEditMessage(topic.chat_id, p.message_id_en, buildText(p, "en"), isMedia);
    }
  }
  return { ok: true, results, slug: p.slug };
}

async function actionDelete(postId: string) {
  const p = await loadPost(postId);
  if (!p) return { error: "post_not_found" };

  const results: Record<string, boolean> = {};
  if (p.message_id_ru) {
    const topic = await getTopic("ru", topicKeyFor(p));
    if (topic) results.ru = await tgDeleteMessage(topic.chat_id, p.message_id_ru);
  }
  if (p.message_id_en) {
    const topic = await getTopic("en", topicKeyFor(p));
    if (topic) results.en = await tgDeleteMessage(topic.chat_id, p.message_id_en);
  }
  const { error } = await supabase.from("analysis_posts").update({ status: "deleted" }).eq("id", postId);
  if (error) console.error("update on delete:", error);
  return { ok: true, results };
}

// Return the current plain-text footers for the admin UI.
async function actionGetFooters() {
  footerCache = null; // force a fresh read
  const f = await loadFooters();
  return { ok: true, footer_ru: f.ru, footer_en: f.en };
}

// Persist the plain-text footers from the admin UI into config.
async function actionSaveFooters(body: any) {
  const ru = typeof body?.footer_ru === "string" ? body.footer_ru.trim() : null;
  const en = typeof body?.footer_en === "string" ? body.footer_en.trim() : null;
  if (ru === null && en === null) return { error: "no_footer_provided" };

  const rows: Array<{ key: string; value: string; description: string; updated_at: string }> = [];
  const now = new Date().toISOString();
  if (ru !== null) rows.push({ key: "footer_ru", value: ru, description: "Referral footer (RU) appended to Telegram posts, before hashtags. Plain text; @BelfedBot auto-linked by edge fn.", updated_at: now });
  if (en !== null) rows.push({ key: "footer_en", value: en, description: "Referral footer (EN) appended to Telegram posts, before hashtags. Plain text; @BelfedBot auto-linked by edge fn.", updated_at: now });

  const { error } = await supabase.from("config").upsert(rows, { onConflict: "key" });
  if (error) { console.error("save_footers:", error); return { error: "save_failed", detail: error.message }; }

  footerCache = null; // invalidate cache so next read reflects the save
  const f = await loadFooters();
  return { ok: true, footer_ru: f.ru, footer_en: f.en };
}

// Preview: render the post with the production builders and send it only to the
// admin's own private Telegram chat. Never touches the channels or the post row.
async function actionPreview(postId: string) {
  const p = await loadPost(postId);
  if (!p) return { error: "post_not_found" };
  { const ce = imageCountError(p); if (ce) return { error: ce, hint: isArticle(p) ? "В статье не больше 50 графиков." : "В обычном посте не больше 4 графиков: удалите лишние или переключите формат на статью." }; }
  await loadFooters();

  const { data: prof } = await supabase
    .from("profiles")
    .select("telegram_id")
    .eq("subscription_status", "admin")
    .not("telegram_id", "is", null)
    .limit(1)
    .maybeSingle();
  if (!prof?.telegram_id) return { error: "admin_chat_not_found" };
  const chatId = Number(prof.telegram_id);

  const langs: Lang[] = [];
  if (p.publish_to_ru) langs.push("ru");
  if (p.publish_to_en) langs.push("en");
  if (langs.length === 0) langs.push("ru");

  const article = isArticle(p);
  const imageUrls = tgImageUrls(p);
  const out: any[] = [];
  for (const lang of langs) {
    if (article) {
      const html = buildRich(p, lang);
      const c = checkRichLength(html);
      if (!c.ok) { out.push({ lang, ok: false, error: "article_too_long", length: c.length, limit: c.limit }); continue; }
      const r = await tgPublishRich(chatId, null, html, null);
      out.push({ lang, ok: r.ok, length: [...html].length, ...(r.ok ? { message_id: r.message_id } : { error: r.error }) });
    } else {
      const text = buildText(p, lang);
      const c = checkLength(text, imageUrls.length);
      if (!c.ok) { out.push({ lang, ok: false, error: "caption_too_long", length: c.length, limit: c.limit }); continue; }
      const r = await tgPublish(chatId, null, text, imageUrls, null);
      out.push({ lang, ok: r.ok, length: text.length, ...(r.ok ? { message_id: r.message_id } : { error: r.error }) });
    }
  }
  const failed = out.filter((r) => !r.ok);
  if (failed.length) return { error: "preview_failed", results: out };
  return { ok: true, format: article ? "article" : "post", results: out };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, x-bot-secret, authorization, apikey",
    }});
  }
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, x-bot-secret, authorization, apikey",
    "Content-Type": "application/json",
  };

  let authorized = false;
  const secret = req.headers.get("x-bot-secret");
  if (secret && secret === BOT_SHARED_SECRET) {
    authorized = true;
  } else {
    const authHdr = req.headers.get("authorization") || "";
    const m = authHdr.match(/^Bearer\s+(.+)$/i);
    if (m) {
      const jwt = m[1];
      try {
        const { data: { user }, error } = await supabase.auth.getUser(jwt);
        if (!error && user) {
          const { data: prof } = await supabase
            .from("profiles")
            .select("subscription_status")
            .eq("id", user.id)
            .maybeSingle();
          if (prof?.subscription_status === "admin") authorized = true;
        }
      } catch (e) { console.error("jwt auth error:", e); }
    }
  }
  if (!authorized) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: cors });

  let body: any;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400, headers: cors }); }

  const { action, post_id } = body ?? {};
  if (!action) {
    return new Response(JSON.stringify({ error: "missing_action" }), { status: 400, headers: cors });
  }

  // Footer admin actions take no post_id.
  const isFooterAction = action === "get_footers" || action === "save_footers";
  if (!isFooterAction && !post_id) {
    return new Response(JSON.stringify({ error: "missing_post_id" }), { status: 400, headers: cors });
  }

  let result;
  try {
    if (action === "publish")                result = await actionPublish(post_id, body?.tg_text_only);
    else if (action === "edit")              result = await actionEdit(post_id);
    else if (action === "delete")            result = await actionDelete(post_id);
    else if (action === "republish_missing") result = await actionRepublishMissing(post_id, body?.tg_text_only);
    else if (action === "preview")           result = await actionPreview(post_id);
    else if (action === "get_footers")       result = await actionGetFooters();
    else if (action === "save_footers")      result = await actionSaveFooters(body);
    else result = { error: "unknown_action" };
  } catch (e) {
    console.error("handler error:", e);
    result = { error: "internal_error", detail: String((e as any)?.message ?? e) };
  }

  const status = (result as any).error ? 400 : 200;
  return new Response(JSON.stringify(result), { status, headers: cors });
});

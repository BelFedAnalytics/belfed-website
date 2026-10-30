// research-render v20: SSR HTML for the public /research/ index and /research/<slug>/ pages
//
// v21 (2026-10-30): the index sidebar box is now a free email subscription
//   (double opt-in via research-subscribe) with TradingView, Telegram and X links.
//
// v20 (2026-10-30): Direction 2 redesign "Mono Header + Readable Text".
//   - Shared site header/footer (belfed-site-header.js / belfed-site-footer.js) are
//     emitted by the renderer itself, so prerendered pages, the 404 fresh render and
//     the index fresh swap all look the same. No legacy <nav>/<footer> any more.
//   - Light theme by default with the site-wide dark theme (html[data-theme="dark"],
//     localStorage "belfed-theme"); prefers-color-scheme when nothing is stored.
//   - Index: hero, sticky filter bar (6 asset classes, search, ?class=&q= in URL,
//     empty state), featured + latest stream, archive grouped by month.
//     Reports without a cover are not listed.
//   - Report: mono meta line, reading time, short disclaimer above the fold, key
//     takeaways (verbatim lead sentences), 640px measure, sticky TOC with scroll-spy
//     (collapsible on mobile), reading progress, chart lightbox, honest member gate,
//     mid and final CTA (free Telegram), email lead form, trust block, prev/next and
//     related reports, one dismissible sticky banner.
//   - Removed hardcoded track-record numbers; the page links to the live track record.
//
// v3 (2026-09-15): hreflang alternates, JSON-LD (Organization, CollectionPage,
// Article, BreadcrumbList), noindex not-found page.
//
//   /functions/v1/research-render?lang=ru|en               -> index
//   /functions/v1/research-render?lang=ru|en&slug=<slug>    -> report
//
// verify_jwt=false, cache-friendly (5 min CDN cache).
//
// Compliance P0 note: the lead form uses source='research_<slug>' and MUST NOT be
// wired to marketing sequences until landing-lead-create split-consent rollout.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { RS_CSS } from "./styles.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Lang = "ru" | "en";

interface ReportRow {
  id: string;
  slug: string;
  report_date: string;
  report_type: string | null;
  title_ru: string | null;
  title_en: string | null;
  subtitle_ru: string | null;
  subtitle_en: string | null;
  asset_classes: string[] | null;
  sectors: string[] | null;
  tags: string[] | null;
  cover_image_url: string | null;
  cover_image_url_ru: string | null;
  cover_image_url_en: string | null;
  published_at: string | null;
  published_public_at: string | null;
  cta_headline_ru?: string | null;
  cta_headline_en?: string | null;
  cta_body_ru?: string | null;
  cta_body_en?: string | null;
  cta_ticker_teaser_ru?: string | null;
  cta_ticker_teaser_en?: string | null;
  words_ru?: number;
  words_en?: number;
}

interface ChartImage { url: string; url_en?: string; caption_ru?: string; caption_en?: string }

interface SectionRow {
  id: string;
  position: number;
  is_conclusion: boolean;
  is_public: boolean;
  section_label_ru: string | null;
  section_label_en: string | null;
  headline_ru?: string | null;
  headline_en?: string | null;
  body_ru?: string | null;
  body_en?: string | null;
  chart_image_url?: string | null;
  chart_caption_ru?: string | null;
  chart_caption_en?: string | null;
  chart_images?: ChartImage[] | null;
  teaser_ru?: string;
  teaser_en?: string;
  teaser_imgs?: string[];
  hidden_words_ru?: number;
  hidden_words_en?: number;
  hidden_charts?: number;
}

const TG_FREE: Record<Lang, string> = { ru: "https://t.me/BelFedFreeRU", en: "https://t.me/BelFedFreeEN" };
const BOT = "https://t.me/belfedbot";

const T = {
  ru: {
    brand: "BelFed Analytics", site: "BelFed", skip: "Перейти к содержимому",
    index_kicker: "// Публичные обзоры BelFed", index_title: "Обзоры рынков",
    index_lead: "Независимые отчёты BelFed Analytics по секторам, отдельным компаниям, макроциклам и крипторынку. Публичные разделы открыты всем, разделы для участников отмечены.",
    index_empty: "Пока нет публичных отчётов. Загляните позже.",
    index_meta_title: "Обзоры рынков | BelFed Analytics",
    index_meta_desc: "Независимые обзоры рынков BelFed Analytics: акции, крипта, макро, сектора и отдельные темы.",
    f_all: "Все", f_group: "Класс активов", f_search_label: "Поиск по отчётам", f_search_ph: "Поиск: Nvidia, биткоин, ФРС",
    f_clear: "Очистить поиск", f_reset: "Сбросить фильтры",
    f_count_all: "Отчётов: {t}", f_count_some: "Найдено: {n} из {t}",
    empty_title: "Ничего не найдено",
    empty_text: "По этому запросу в выбранном классе активов отчётов нет. Попробуйте запрос короче или сбросьте фильтры.",
    cls: { equities: "Акции", crypto: "Криптовалюты", macro: "Макро", rates: "Облигации и ставки", commodities: "Сырьё", fx: "Валюты" } as Record<string, string>,
    type: { daily: "Обзор", weekly: "Недельный обзор", flash: "Экспресс-обзор" } as Record<string, string>,
    type_default: "Отчёт",
    latest: "Новое", archive: "Архив", results: "Результаты", by_date: "по дате", read: "Читать",
    min_read: "{n} мин чтения",
    sub_kicker: "// Бесплатно на почту", sub_title: "Бесплатные отчёты на почту",
    sub_text: "Обзоры рынков BelFed Analytics приходят прямо на вашу почту. Бесплатно, без спама, отписка в один клик.",
    sub_email: "Ваш email", sub_btn: "Подписаться",
    sub_consent: "Я согласен получать на email бесплатные исследования BelFed Analytics. Отписаться можно в один клик в любом письме.",
    sub_privacy: "Политика конфиденциальности",
    sub_pending: "Почти готово. Мы отправили письмо со ссылкой для подтверждения. Откройте его, чтобы начать получать отчёты.",
    sub_confirming: "Подтверждаем подписку…",
    sub_confirmed: "Подписка подтверждена. Новые бесплатные отчёты будут приходить на вашу почту.",
    sub_expired: "Ссылка для подтверждения устарела. Подпишитесь ещё раз, и мы пришлём новую.",
    sub_invalid: "Проверьте адрес email.", sub_no_consent: "Отметьте согласие, чтобы подписаться.",
    sub_rate: "Слишком много попыток. Попробуйте через час.", sub_err: "Не получилось подписаться. Попробуйте, пожалуйста, ещё раз через минуту.",
    soc_kicker: "// Бесплатные каналы", soc_label: "BelFed в соцсетях", new_tab: "откроется в новой вкладке",
    nl_kicker: "// Для участников", nl_title: "От обзоров к сделкам",
    nl_text: "Участники получают входы, стопы и цели по этим темам в Telegram и на дашборде. Каждая закрытая сделка попадает в публичную историю сделок.",
    nl_trial: "14 дней бесплатно", nl_track: "История сделок",
    crumb: "Все обзоры", report_kicker: "// Обзор рынка",
    published: "Опубликовано", author: "Автор",
    copy: "Скопировать ссылку", copied: "Ссылка скопирована", share_tg: "Telegram", share_x: "X", share: "Поделиться",
    disc_short: "Аналитика, а не инвестиционная рекомендация. Независимое рыночное исследование в информационных целях, оно не учитывает вашу ситуацию. Рынки связаны с риском убытков.",
    disc_link: "Полный дисклеймер",
    takeaways: "Главное в отчёте",
    toc: "Содержание", progress: "Прогресс чтения",
    chart: "График", source: "Источник", enlarge: "Увеличить", enlarge_aria: "Открыть график в полном размере", close: "Закрыть",
    locked_label: "Раздел для участников", locked_title: "Продолжение раздела открыто участникам",
    locked_text: "За этой отметкой: продолжение раздела{w}{c}. Участники читают его полностью на сайте и в Telegram.",
    locked_words: (n: number) => ` (около ${n} ${plural(n, "слова", "слов", "слов")})`,
    locked_charts: (n: number) => ` и ${n} ${plural(n, "график", "графика", "графиков")}`,
    locked_cta: "Открыть 14 дней бесплатно", locked_login: "Уже участник? Войти",
    locked_fine: "Без карты. Отмена в любой момент.",
    chart_locked: "Для участников",
    mid_kicker: "// Бесплатный доступ", mid_title: "Публичные отчёты выходят в бесплатном Telegram-канале",
    mid_text: "Пост только в момент публикации отчёта. Сделки участников со входами и стопами ведутся отдельно.",
    mid_btn: "Открыть бесплатный канал", mid_alt: "Или посмотреть публичную историю сделок",
    final_kicker: "// Следующий шаг", final_title: "Следите за темой дальше",
    final_text: "Публичные обзоры в Telegram бесплатны. Участники также получают входы, стопы и цели по этим темам в Telegram и на дашборде, а каждая закрытая сделка попадает в публичную историю сделок.",
    final_tg: "Бесплатный Telegram-канал", final_trial: "14 дней бесплатно",
    lead_kicker: "// Или по email",
    lead_title: "Получить уведомление, когда откроем позицию",
    lead_text: "Одно короткое письмо, когда мы совершим сделку по этой теме. Отписка в один клик.",
    lead_email_placeholder: "you@example.com", lead_email_label: "Email",
    lead_consent: "Я согласен получать исследовательские материалы BelFed и уведомления по этой теме по email. Одно короткое письмо за раз, отписка в один клик.",
    lead_submit: "Уведомить меня",
    lead_ok: "Готово. Мы напишем вам, когда сработает сделка по этой теме.",
    lead_err: "Что-то пошло не так. Попробуйте, пожалуйста, ещё раз через минуту.",
    lead_no_consent: "Пожалуйста, отметьте согласие, чтобы продолжить.",
    trust_track: "Публичная история сделок", trust_track_text: "Каждая закрытая сделка записана со входом, выходом и результатом в R.",
    trust_track_link: "Открыть историю",
    disclaimer_label: "Дисклеймер.",
    disclaimer_body: 'Данный отчёт является независимым рыночным исследованием BelFed Analytics, публикуемым в информационных и образовательных целях. Он не является инвестиционной рекомендацией, офертой или приглашением к совершению сделок с ценными бумагами, цифровыми активами или производными инструментами, и не учитывает целей, финансового положения или потребностей конкретного читателя. Изложенные взгляды отражают наш анализ на дату публикации и могут изменяться без уведомления. Любое решение действовать на основе этого материала остаётся полностью на ответственности читателя. Торговля и инвестиции сопряжены с риском убытков, вплоть до потери всего капитала. Полный текст: <a href="/disclaimer.html">дисклеймер</a> и <a href="/privacy.html">политика конфиденциальности</a>.',
    prev: "Предыдущий отчёт", next: "Следующий отчёт", related: "Похожие отчёты", related_sub: "по классу активов",
    banner_text: "Публичные отчёты бесплатно в Telegram.", banner_btn: "Открыть канал", banner_close: "Скрыть",
    section: "Раздел",
    nf_title: "Отчёт не найден", nf_text: "Возможно, отчёт был снят с публикации или ссылка устарела.", nf_back: "Ко всем обзорам",
  },
  en: {
    brand: "Belfed Analytics", site: "Belfed", skip: "Skip to main content",
    index_kicker: "// Belfed public commentary", index_title: "Market Commentary",
    index_lead: "Independent Belfed Analytics reports on sectors, single-name themes, macro cycles and crypto. Public sections are open to everyone; member sections are marked.",
    index_empty: "No public reports yet. Check back soon.",
    index_meta_title: "Market Commentary | Belfed Analytics",
    index_meta_desc: "Independent Belfed Analytics market commentary: equities, crypto, macro, sectors, and single-name themes.",
    f_all: "All", f_group: "Asset class", f_search_label: "Search reports", f_search_ph: "Search: Nvidia, bitcoin, Fed",
    f_clear: "Clear search", f_reset: "Reset filters",
    f_count_all: "{t} reports", f_count_some: "{n} of {t} reports",
    empty_title: "Nothing found",
    empty_text: "No reports match this search in the selected asset class. Try a shorter query or reset the filters.",
    cls: { equities: "Equities", crypto: "Crypto", macro: "Macro", rates: "Rates & credit", commodities: "Commodities", fx: "FX" } as Record<string, string>,
    type: { daily: "Brief", weekly: "Weekly", flash: "Flash note" } as Record<string, string>,
    type_default: "Report",
    latest: "The latest", archive: "Archive", results: "Results", by_date: "by date", read: "Read",
    min_read: "{n} min read",
    sub_kicker: "// Free by email", sub_title: "Free reports in your inbox",
    sub_text: "Belfed Analytics market commentary delivered straight to your email. Free, no spam, unsubscribe in one click.",
    sub_email: "Your email", sub_btn: "Subscribe",
    sub_consent: "I agree to receive free Belfed Analytics research by email. I can unsubscribe in one click from any email.",
    sub_privacy: "Privacy policy",
    sub_pending: "Almost done. We sent you an email with a confirmation link. Open it to start receiving reports.",
    sub_confirming: "Confirming your subscription…",
    sub_confirmed: "Subscription confirmed. New free reports will arrive in your inbox.",
    sub_expired: "This confirmation link has expired. Subscribe again and we will send a new one.",
    sub_invalid: "Please check your email address.", sub_no_consent: "Please tick the consent box to subscribe.",
    sub_rate: "Too many attempts. Please try again in an hour.", sub_err: "Could not subscribe. Please try again in a minute.",
    soc_kicker: "// Free channels", soc_label: "Belfed on social media", new_tab: "opens in a new tab",
    nl_kicker: "// For members", nl_title: "From commentary to trades",
    nl_text: "Members get entries, stops and targets on these themes in Telegram and on the dashboard. Every closed trade is logged in the public track record.",
    nl_trial: "14-day free access", nl_track: "Track record",
    crumb: "All commentary", report_kicker: "// Market commentary",
    published: "Published", author: "Author",
    copy: "Copy link", copied: "Link copied", share_tg: "Telegram", share_x: "X", share: "Share",
    disc_short: "Analytics, not investment advice. Independent market research for information only; it does not consider your situation. Markets carry risk of loss.",
    disc_link: "Full disclaimer",
    takeaways: "Key takeaways",
    toc: "Contents", progress: "Reading progress",
    chart: "Chart", source: "Source", enlarge: "Enlarge", enlarge_aria: "Open chart at full size", close: "Close",
    locked_label: "Member section", locked_title: "The rest of this section is for members",
    locked_text: "Behind this marker: the rest of this section{w}{c}. Members read it in full on the site and in Telegram.",
    locked_words: (n: number) => ` (about ${n} words)`,
    locked_charts: (n: number) => ` and ${n} ${n === 1 ? "chart" : "charts"}`,
    locked_cta: "Get 14-day free access", locked_login: "Already a member? Log in",
    locked_fine: "No card required. Cancel any time.",
    chart_locked: "Members only",
    mid_kicker: "// Free access", mid_title: "Public reports arrive in the free Telegram channel",
    mid_text: "A post only when a report is published. Member trades with entries and stops are a separate service.",
    mid_btn: "Open free channel", mid_alt: "Or read the public track record",
    final_kicker: "// Next step", final_title: "Keep following this theme",
    final_text: "Public commentary in Telegram is free. Members also get entries, stops and targets on these themes in Telegram and on the dashboard, and every closed trade is logged in the public track record.",
    final_tg: "Free Telegram channel", final_trial: "14-day free access",
    lead_kicker: "// Or by email",
    lead_title: "Get notified when we open the first position",
    lead_text: "One short email when we act on this theme. Unsubscribe in one click.",
    lead_email_placeholder: "you@example.com", lead_email_label: "Email",
    lead_consent: "I agree to receive Belfed research updates and alerts on this theme by email. One short email at a time, unsubscribe in one click.",
    lead_submit: "Notify me",
    lead_ok: "Got it. We'll email you when we act on this theme.",
    lead_err: "Something went wrong. Please try again in a minute.",
    lead_no_consent: "Please tick the consent box to continue.",
    trust_track: "Public track record", trust_track_text: "Every closed trade is logged with entry, exit and result in R.",
    trust_track_link: "Open the track record",
    disclaimer_label: "Disclaimer.",
    disclaimer_body: 'This report is independent market research produced by Belfed Analytics for informational and educational purposes only. It is not investment advice, an offer, or a solicitation to buy or sell any security, digital asset, or derivative, and it does not take into account the reader\'s objectives, financial situation, or needs. Views expressed reflect our analysis on the publication date and may change without notice. Any decision to act on this material is the reader\'s sole responsibility. Trading and investing carry risk of loss, including total loss of capital. See our full <a href="/disclaimer.html">disclaimer</a> and <a href="/privacy.html">privacy policy</a>.',
    prev: "Previous report", next: "Next report", related: "Related reports", related_sub: "by asset class",
    banner_text: "Public reports are free in Telegram.", banner_btn: "Open channel", banner_close: "Dismiss",
    section: "Section",
    nf_title: "Report not found", nf_text: "The report may have been unpublished or the link is out of date.", nf_back: "Back to Market Commentary",
  },
};
type Dict = typeof T.ru;

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
function tpl(s: string, o: Record<string, string | number>): string { return s.replace(/\{(\w+)\}/g, (_, k) => String(o[k] ?? "")); }

const MONTHS_RU = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
const MONTHS_RU_NOM = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
const MONTHS_EN = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function fmtDate(lang: Lang, iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return lang === "ru" ? `${d.getUTCDate()} ${MONTHS_RU[d.getUTCMonth()]} ${d.getUTCFullYear()}` : `${MONTHS_EN[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
function isoDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}
function monthKey(iso: string | null | undefined): string { return isoDay(iso).slice(0, 7); }
function monthLabel(lang: Lang, key: string): string {
  const [y, m] = key.split("-").map(Number);
  if (!y || !m) return key;
  return `${(lang === "ru" ? MONTHS_RU_NOM : MONTHS_EN)[m - 1]} ${y}`;
}

function esc(s: string | null | undefined): string {
  if (!s) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
const attr = esc;

// ---------- body text ----------
function inline(p: string): string {
  let out = esc(p);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
  // Bare links to our own sites (track-record deep links) become clickable.
  out = out.replace(/(^|[\s(>])(https:\/\/(?:www\.)?belfed\.(?:com|ru)\/[^\s<)"']*)/g, (_, pre, u) => `${pre}<a href="${u}">${u.replace(/^https:\/\//, "")}</a>`);
  return out;
}
function renderTable(lines: string[]): string {
  const rows = lines.map(l => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim()));
  const isSep = (r: string[]) => r.every(c => /^:?-{2,}:?$/.test(c));
  let head: string[] | null = null;
  let body = rows;
  if (rows.length > 1 && isSep(rows[1])) { head = rows[0]; body = rows.slice(2); }
  return `<div class="tbl-wrap"><div class="tbl-scroll" tabindex="0"><table>${head ? `<thead><tr>${head.map(c => `<th scope="col">${inline(c)}</th>`).join("")}</tr></thead>` : ""}<tbody>${body.filter(r => !isSep(r)).map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></div>`;
}
function renderBody(text: string | null | undefined): string {
  if (!text) return "";
  const blocks = String(text).replace(/\r\n?/g, "\n").split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  return blocks.map(p => {
    const lines = p.split("\n");
    if (lines.length >= 2 && lines.every(l => /^\s*\|.*\|\s*$/.test(l))) return renderTable(lines);
    if (lines.every(l => /^\s*[-•]\s+/.test(l))) return `<ul>${lines.map(l => `<li>${inline(l.replace(/^\s*[-•]\s+/, ""))}</li>`).join("")}</ul>`;
    return `<p>${lines.map(inline).join("<br>")}</p>`;
  }).join("\n");
}
function plainText(s: string | null | undefined): string {
  return String(s || "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s*\|.*\|\s*$/gm, "")
    .replace(/\s+/g, " ").trim();
}
function wordCount(s: string | null | undefined): number {
  const p = plainText(s);
  return p ? p.split(" ").length : 0;
}
function sentences(s: string | null | undefined): string[] {
  const p = plainText(s);
  if (!p) return [];
  const parts = p.split(/(?<=[.!?…])\s+(?=[A-ZА-ЯЁ0-9$«"(])/);
  const out: string[] = [];
  for (const part of parts) {
    if (out.length && out[out.length - 1].length < 40) out[out.length - 1] += " " + part;
    else out.push(part);
  }
  return out.map(x => x.trim()).filter(x => x.length >= 25);
}
function clip(s: string, max = 300): string {
  return s.length <= max ? s : s.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

// ---------- report helpers ----------
function domain(lang: Lang): string { return lang === "ru" ? "belfed.ru" : "belfed.com"; }
function reportTitle(r: ReportRow, lang: Lang): string {
  const t = lang === "ru" ? r.title_ru : r.title_en;
  return t || r.title_en || r.title_ru || r.slug;
}
function reportSubtitle(r: ReportRow, lang: Lang): string { return (lang === "ru" ? r.subtitle_ru : r.subtitle_en) || ""; }
function typeLabel(r: ReportRow, t: Dict): string { return t.type[String(r.report_type || "").toLowerCase()] || t.type_default; }
function readMinutes(words: number, lang: Lang): number { return Math.max(1, Math.round(words / (lang === "ru" ? 170 : 210))); }
function cleanTag(s: string): string { return String(s || "").replace(/^#+/, "").trim(); }

// Covers and charts come from our own Supabase storage. Anything else is ignored so
// a bad value in the DB can never inject markup or pull third-party images.
function safeImg(u: string | null | undefined): string | null {
  if (!u) return null;
  return /^https:\/\/obujqvqqmyfcfflhqvud\.supabase\.co\/storage\/v1\/object\/public\/[A-Za-z0-9._\/-]+\.(png|jpe?g|webp)$/i.test(u) ? u : null;
}
function coverOf(r: ReportRow, lang: Lang): string | null {
  return safeImg((lang === "ru" ? r.cover_image_url_ru : r.cover_image_url_en) || r.cover_image_url);
}

// Gated teaser: a short excerpt and tiny thumbnails only. Full body, captions and
// full-size chart URLs never reach the public HTML.
function teaserText(body: string | null | undefined, max = 260): string {
  const plain = String(body || "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();
  if (!plain) return "";
  const limit = Math.max(120, Math.min(max, Math.round(plain.length * 0.4)));
  if (plain.length <= limit) return plain.slice(0, Math.round(plain.length * 0.6)).replace(/\s+\S*$/, "") + "…";
  const cut = plain.slice(0, limit);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  const base = lastStop > limit * 0.55 ? cut.slice(0, lastStop + 1) : cut.replace(/\s+\S*$/, "");
  return base + " …";
}
function teaserThumb(u: string | null | undefined): string | null {
  const ok = safeImg(u);
  if (!ok) return null;
  return ok.replace("/storage/v1/object/public/", "/storage/v1/render/image/public/") + "?width=64&height=40&resize=contain&quality=40";
}

const CLASS_ORDER = ["equities", "crypto", "macro", "rates", "commodities", "fx"] as const;
const CLASS_RULES: Record<string, RegExp> = {
  equities: /^(equit|stock|etf|s&p|nasdaq|ndx|spx|акци)/,
  crypto: /(crypto|bitcoin|btc|altcoin|on-chain|ethereum|крипт|биткоин)/,
  macro: /^(macro|labou?r|inflation|макро)/,
  rates: /(bond|^rates?$|fixed income|credit|yield|treasur|облигац)/,
  commodities: /(commodit|^gold$|^silver$|^oil$|copper|сырь)/,
  fx: /^(fx|currenc|dxy|валют)/,
};
function reportClasses(r: ReportRow): string[] {
  const own = (r.asset_classes || []).map(x => String(x).trim().toLowerCase()).filter(Boolean);
  const extra = [...(r.sectors || []), ...(r.tags || [])].map(x => String(x).trim().toLowerCase()).filter(Boolean);
  const out: string[] = [];
  for (const c of CLASS_ORDER) {
    const re = CLASS_RULES[c];
    // asset_classes is authoritative; sectors/tags only add crypto (often filed as a sector)
    if (own.some(x => re.test(x)) || (c === "crypto" && extra.some(x => re.test(x)))) out.push(c);
  }
  return out;
}
function searchText(r: ReportRow, lang: Lang, dateStr: string, classes: string[]): string {
  const t = T[lang];
  return [reportTitle(r, lang), reportSubtitle(r, lang), dateStr, typeLabel(r, t), ...(r.asset_classes || []), ...(r.sectors || []), ...(r.tags || []).map(cleanTag), ...classes.map(c => t.cls[c] || c)]
    .filter(Boolean).join(" ").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
}
function tagsHtml(r: ReportRow, t: Dict, nClasses: number): string {
  const classes = reportClasses(r).slice(0, nClasses);
  return `<div class="tags"><span class="tag type">${esc(typeLabel(r, t))}</span>${classes.map(c => `<span class="tag cls">${esc(t.cls[c])}</span>`).join("")}</div>`;
}
function minRead(r: ReportRow, lang: Lang, t: Dict): string {
  const w = lang === "ru" ? r.words_ru : r.words_en;
  return w ? tpl(t.min_read, { n: readMinutes(w, lang) }) : "";
}

// ---------- head ----------
const ORG_ID = "https://belfed.com/#organization";
function orgNode(lang: Lang) {
  return {
    "@type": "Organization",
    "@id": ORG_ID,
    name: T[lang].brand,
    url: `https://${domain(lang)}/`,
    logo: `https://${domain(lang)}/logo-belfed-512.png`,
    sameAs: [
      "https://belfed.com/",
      "https://belfed.ru/",
      "https://t.me/BelFedFreeEN",
      "https://t.me/BelFedFreeRU",
      "https://x.com/art_the_trader",
      "https://www.tradingview.com/u/BelFed_Analytics/",
    ],
  };
}
function altPair(path: string): string {
  return `  <link rel="alternate" hreflang="ru" href="${attr(`https://belfed.ru${path}`)}" />
  <link rel="alternate" hreflang="en" href="${attr(`https://belfed.com${path}`)}" />
  <link rel="alternate" hreflang="x-default" href="${attr(`https://belfed.com${path}`)}" />`;
}
function jsonLdBlock(obj: unknown): string {
  // JSON-LD must not be HTML-escaped, but "<" has to be neutralised so a stray
  // tag inside a title cannot break out of the script element.
  const raw = JSON.stringify(obj).replace(/</g, "\\u003c");
  return `  <script type="application/ld+json">${raw}</script>`;
}
function jsonData(id: string, obj: unknown): string {
  return `<script type="application/json" id="${id}">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;
}

// Theme before first paint: stored choice wins, otherwise the OS preference.
const THEME_INIT = `<script>(function(){var t;try{t=localStorage.getItem('belfed-theme');}catch(e){}if(t!=='dark'&&t!=='light'){t=window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.setAttribute('data-theme',t);})();</script>`;
const FONTS = `https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&display=swap`;

function headBase(lang: Lang, opts: { title: string; description: string; canonical: string; ogTitle: string; ogDescription: string; ogImage: string; ogType?: "website" | "article"; altPath?: string; jsonLd?: unknown[]; robots?: string; preloadImg?: string | null; }): string {
  return `<!DOCTYPE html>
<html lang="${lang}" data-theme="light">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  ${THEME_INIT}
  <link rel="icon" type="image/png" href="/logo-belfed-512.png">
  <title>${esc(opts.title)}</title>
  <link rel="canonical" href="${attr(opts.canonical)}" />
  <meta name="description" content="${attr(opts.description)}" />
  <meta property="og:type" content="${opts.ogType || "website"}" />
  <meta property="og:site_name" content="${T[lang].site}" />
  <meta property="og:title" content="${attr(opts.ogTitle)}" />
  <meta property="og:description" content="${attr(opts.ogDescription)}" />
  <meta property="og:url" content="${attr(opts.canonical)}" />
  <meta property="og:image" content="${attr(opts.ogImage)}" />
  ${/og-belfed\.png$/.test(opts.ogImage) ? `<meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />` : `<meta property="og:image:alt" content="${attr(opts.ogTitle)}" />`}
  <meta property="og:locale" content="${lang === "ru" ? "ru_RU" : "en_US"}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${attr(opts.ogTitle)}" />
  <meta name="twitter:description" content="${attr(opts.ogDescription)}" />
  <meta name="twitter:image" content="${attr(opts.ogImage)}" />
${opts.robots ? `  <meta name="robots" content="${attr(opts.robots)}" />\n` : ""}${opts.altPath ? altPair(opts.altPath) + "\n" : ""}${(opts.jsonLd || []).map(jsonLdBlock).join("\n")}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="${FONTS}">
${opts.preloadImg ? `  <link rel="preload" as="image" href="${attr(opts.preloadImg)}" fetchpriority="high">\n` : ""}  <style>${RS_CSS}</style>
  <script src="/belfed-site-header.js" data-lang="${lang}" defer></script>
  <script src="/belfed-site-footer.js" data-lang="${lang}" defer></script>`;
}

// Keeps sticky offsets in line with the shared header, whatever its height.
const HDR_JS = String.raw`(function(){function s(){var h=document.querySelector('#bf-site-header .bf-bar')||document.getElementById('bf-site-header');if(h&&h.offsetHeight)document.documentElement.style.setProperty('--hdr',h.offsetHeight+'px');}document.addEventListener('DOMContentLoaded',s);window.addEventListener('load',s);window.addEventListener('resize',s);setTimeout(s,400);})();`;

const ICON = {
  link: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>`,
  lock: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`,
  search: `<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
};

// The static /research/ index can lag behind publishing (GitHub cron). On load,
// compare it with research-list; if a newer public report with a cover exists, swap
// in a fresh render from this function. One attempt per set of missing slugs.
function freshScript(lang: Lang): string {
  return `<script>
(function(){
  try{
    var F=${JSON.stringify(SUPABASE_URL + "/functions/v1/")}, L=${JSON.stringify(lang)};
    var have={}; [].forEach.call(document.querySelectorAll('a.card'),function(a){have[a.getAttribute('href')]=1;});
    fetch(F+'research-list?lang='+L,{cache:'no-store'}).then(function(r){return r.ok?r.json():null;}).then(function(j){
      var items=(j&&j.items)||[]; var miss=items.filter(function(it){return it&&it.slug&&(it['cover_image_url_'+L]||it.cover_image_url)&&!have['/research/'+it.slug+'/'];}).map(function(it){return it.slug;});
      if(!miss.length) return;
      var k='rs_fresh_'+L+'_'+miss.join(','); if(sessionStorage.getItem(k)) return; sessionStorage.setItem(k,'1');
      return fetch(F+'research-render?lang='+L+'&v='+Date.now(),{cache:'no-store'}).then(function(r){return r.ok?r.text():null;}).then(function(h){
        if(h&&h.indexOf('class="cards"')>-1){document.open();document.write(h);document.close();}
      });
    }).catch(function(){});
  }catch(e){}
})();
</script>`;
}


// ---------- free email subscription + social channels ----------
const SOCIAL_SVG = {
  tradingview: `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path fill="currentColor" d="M15.8654 8.2789c0 1.3541-1.0978 2.4519-2.452 2.4519-1.354 0-2.4519-1.0978-2.4519-2.452 0-1.354 1.0978-2.4518 2.452-2.4518 1.3541 0 2.4519 1.0977 2.4519 2.4519zM9.75 6H0v4.9038h4.8462v7.2692H9.75Zm8.5962 0H24l-5.1058 12.173h-5.6538z"/></svg>`,
  telegram: `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path fill="currentColor" d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>`,
  x: `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path fill="currentColor" d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z"/></svg>`,
};
function socialLinks(lang: Lang, t: Dict): string {
  const items = [
    { k: "tradingview", name: "TradingView", handle: "BelFed_Analytics", href: "https://www.tradingview.com/u/BelFed_Analytics/" },
    { k: "telegram", name: "Telegram", handle: lang === "ru" ? "@BelFedFreeRU" : "@BelFedFreeEN", href: TG_FREE[lang] },
    { k: "x", name: "X", handle: "@art_the_trader", href: "https://x.com/art_the_trader" },
  ] as const;
  return `<div class="soc"><div class="kicker">${esc(t.soc_kicker)}</div><ul aria-label="${attr(t.soc_label)}">${items.map(i =>
    `<li><a class="soc-a soc-${i.k}" href="${i.href}" target="_blank" rel="noopener" title="${attr(i.name + " · " + i.handle)}"><span class="ic">${SOCIAL_SVG[i.k]}</span><span class="nm">${esc(i.name)}</span><span class="rs-sr"> ${esc(i.handle)}, ${esc(t.new_tab)}</span></a></li>`).join("")}</ul></div>`;
}
function subscribeBox(lang: Lang, t: Dict): string {
  return `<section class="sub" id="rsSub" aria-labelledby="rsSubH">
          <div class="kicker gold">${esc(t.sub_kicker)}</div>
          <h3 id="rsSubH">${esc(t.sub_title)}</h3>
          <p>${esc(t.sub_text)}</p>
          <form id="subForm" novalidate>
            <label for="subEmail" class="rs-sr">${esc(t.sub_email)}</label>
            <div class="sub-field"><input type="email" id="subEmail" name="email" placeholder="you@example.com" required autocomplete="email" inputmode="email" spellcheck="false"><button type="submit" class="btn sm primary" id="subBtn">${esc(t.sub_btn)}</button></div>
            <label class="consent"><input type="checkbox" id="subConsent"><span>${esc(t.sub_consent)} <a href="/privacy.html">${esc(t.sub_privacy)}</a></span></label>
            <div class="hp" aria-hidden="true"><input type="text" id="subHp" tabindex="-1" autocomplete="off"></div>
            <div class="msg ok" id="subOk" role="status" hidden></div>
            <div class="msg err" id="subErr" role="alert" hidden></div>
          </form>
          ${socialLinks(lang, t)}
        </section>`;
}
const SUB_JS = String.raw`(function(){
  var form=document.getElementById('subForm'); if(!form) return;
  var C=JSON.parse(document.getElementById('subCfg').textContent);
  var ok=document.getElementById('subOk'), err=document.getElementById('subErr'), btn=document.getElementById('subBtn');
  var api=C.supaUrl+'/functions/v1/research-subscribe';
  function show(el,msg){ok.hidden=true; err.hidden=true; if(el){el.textContent=msg; el.hidden=false;}}
  function post(body){return fetch(api,{method:'POST',headers:{'Content-Type':'application/json','apikey':C.supaKey,'Authorization':'Bearer '+C.supaKey},body:JSON.stringify(body)}).then(function(r){return r.json().catch(function(){return {ok:false,error:'server_error'};}).then(function(j){j._s=r.status; return j;});});}
  function errMsg(j){return j.error==='invalid_email'?C.invalid:j.error==='consent_required'?C.noConsent:j.error==='rate_limited'?C.rate:j.error==='expired'?C.expired:C.err;}
  // confirmation link from the email: ?confirm=<token>
  try{
    var u=new URL(location.href), tok=u.searchParams.get('confirm');
    if(tok){
      u.searchParams.delete('confirm'); history.replaceState(null,'',u.pathname+u.search+'#rsSub');
      show(ok,C.confirming);
      var box=document.getElementById('rsSub'); if(box&&box.scrollIntoView) box.scrollIntoView({block:'center'});
      post({action:'confirm',token:tok}).then(function(j){ if(j.ok){show(ok,C.confirmed); form.querySelector('.sub-field').hidden=true; form.querySelector('.consent').hidden=true; if(window.belfedTrack) window.belfedTrack('research_subscribe_confirmed',{});} else show(err,errMsg(j)); }).catch(function(){show(err,C.err);});
    }
  }catch(e){}
  form.addEventListener('submit',function(e){
    e.preventDefault();
    var email=(document.getElementById('subEmail').value||'').trim();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)){show(err,C.invalid); document.getElementById('subEmail').focus(); return;}
    if(!document.getElementById('subConsent').checked){show(err,C.noConsent); document.getElementById('subConsent').focus(); return;}
    var label=btn.textContent; btn.disabled=true; btn.textContent='…';
    var payload={email:email,lang:C.lang,consent:true,page:location.pathname,website:document.getElementById('subHp').value||''};
    post(payload).then(function(j){
      btn.disabled=false; btn.textContent=label;
      if(j.ok){show(ok,C.pending); form.reset(); if(window.belfedTrack) window.belfedTrack('research_subscribe_requested',{});}
      else show(err,errMsg(j));
    }).catch(function(){btn.disabled=false; btn.textContent=label; show(err,C.err);});
  });
})();`;

// ---------- index ----------
const INDEX_JS = String.raw`(function(){
  var bar=document.getElementById('rsBar'); if(!bar) return;
  var cfg=JSON.parse(document.getElementById('rsCfg').textContent);
  bar.hidden=false;
  var cards=[].slice.call(document.querySelectorAll('#rsCards a.card'));
  var months=[].slice.call(document.querySelectorAll('#rsCards .month'));
  var chips=[].slice.call(bar.querySelectorAll('.rs-chip'));
  var q=document.getElementById('rsQ'), clr=document.getElementById('rsClear'), cnt=document.getElementById('rsCount'), empty=document.getElementById('rsEmpty');
  var top=document.getElementById('rsTop'), title=document.getElementById('rsListTitle'), head=document.getElementById('rsListHead');
  var cls='';
  function norm(s){return (s||'').toLowerCase().replace(/ё/g,'е').trim();}
  function fmt(n,t){return (n===t?cfg.all:cfg.some).replace('{n}',n).replace('{t}',t);}
  function apply(push){
    var terms=norm(q.value).split(/\s+/).filter(Boolean), shown=0;
    cards.forEach(function(c){
      var okC=!cls||(' '+c.getAttribute('data-classes')+' ').indexOf(' '+cls+' ')>-1;
      var hay=c.getAttribute('data-search')||'';
      var ok=okC&&terms.every(function(w){return hay.indexOf(w)>-1;});
      c.hidden=!ok; if(ok) shown++;
    });
    months.forEach(function(m){m.hidden=!m.querySelector('a.card:not([hidden])');});
    var active=!!(cls||terms.length);
    if(top) top.hidden=active;
    if(title) title.textContent=active?cfg.results:cfg.archive;
    if(head) head.hidden=shown===0;
    chips.forEach(function(b){var a=b.getAttribute('data-class')===cls; b.classList.toggle('is-active',a); b.setAttribute('aria-pressed',a?'true':'false');});
    clr.hidden=!q.value; cnt.textContent=fmt(shown,cards.length); empty.hidden=shown>0;
    if(push){try{var u=new URL(location.href); if(cls)u.searchParams.set('class',cls); else u.searchParams.delete('class'); if(q.value.trim())u.searchParams.set('q',q.value.trim()); else u.searchParams.delete('q'); history.replaceState(null,'',u.pathname+u.search+u.hash);}catch(e){}}
  }
  chips.forEach(function(b){b.addEventListener('click',function(){var k=b.getAttribute('data-class'); cls=(cls===k&&k)?'':k; apply(true);});});
  var tm; q.addEventListener('input',function(){clearTimeout(tm); tm=setTimeout(function(){apply(true);},120);});
  q.addEventListener('keydown',function(e){if(e.key==='Escape'&&q.value){q.value='';apply(true);}});
  clr.addEventListener('click',function(){q.value='';apply(true);q.focus();});
  document.getElementById('rsReset').addEventListener('click',function(){q.value='';cls='';apply(true);q.focus();});
  try{var p=new URLSearchParams(location.search); var pc=p.get('class')||''; if(chips.some(function(b){return b.getAttribute('data-class')===pc;})) cls=pc; q.value=p.get('q')||'';}catch(e){}
  apply(false);
})();`;

function rowCard(r: ReportRow, lang: Lang, t: Dict): string {
  const title = reportTitle(r, lang), sub = reportSubtitle(r, lang);
  const iso = isoDay(r.report_date || r.published_at);
  const dateStr = fmtDate(lang, iso);
  const cover = coverOf(r, lang)!;
  const classes = reportClasses(r);
  const mr = minRead(r, lang, t);
  return `<a href="/research/${esc(r.slug)}/" class="card row-card" data-classes="${attr(classes.join(" "))}" data-search="${attr(searchText(r, lang, dateStr, classes))}">
        <div class="cover"><img src="${attr(cover)}" alt="" loading="lazy" decoding="async" width="1672" height="941"></div>
        <div>${tagsHtml(r, t, 2)}
          <h3>${esc(title)}</h3>
          ${sub ? `<p class="sum">${esc(sub)}</p>` : ""}
          <div class="meta">${iso ? `<time datetime="${iso}">${esc(dateStr)}</time>` : ""}${mr ? `<span>${esc(mr)}</span>` : ""}</div>
        </div>
      </a>`;
}

function renderIndex(lang: Lang, all: ReportRow[]): string {
  const t = T[lang];
  const dom = domain(lang);
  const canonical = `https://${dom}/research/`;
  const reports = all.filter(r => coverOf(r, lang));
  const head = headBase(lang, {
    title: t.index_meta_title, description: t.index_meta_desc, canonical,
    ogTitle: t.index_meta_title, ogDescription: t.index_meta_desc, ogImage: `https://${dom}/og-belfed.png`, ogType: "website",
    altPath: "/research/",
    preloadImg: reports[0] ? coverOf(reports[0], lang) : null,
    jsonLd: [
      orgNode(lang),
      {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "@id": canonical,
        url: canonical,
        name: t.index_meta_title,
        description: t.index_meta_desc,
        inLanguage: lang === "ru" ? "ru-RU" : "en-US",
        isPartOf: { "@type": "WebSite", url: `https://${dom}/`, name: t.site },
        publisher: { "@id": ORG_ID },
        hasPart: reports.slice(0, 50).map(r => ({
          "@type": "Article",
          headline: reportTitle(r, lang),
          url: `https://${dom}/research/${r.slug}/`,
          datePublished: r.published_at || r.report_date || undefined,
        })),
      },
    ],
  });

  let content: string;
  if (reports.length === 0) {
    content = `<div class="rs-wrap"><div class="empty"><div class="kicker">// 0</div><p>${esc(t.index_empty)}</p></div></div>`;
  } else {
    const counts: Record<string, number> = {};
    for (const r of reports) for (const c of reportClasses(r)) counts[c] = (counts[c] || 0) + 1;
    const chip = (key: string, label: string, n: number, active: boolean) =>
      `<button type="button" class="rs-chip${active ? " is-active" : ""}" data-class="${key}" aria-pressed="${active}">${esc(label)} <span class="rs-n">${n}</span></button>`;
    const bar = `<div class="rs-bar" id="rsBar" hidden>
    <div class="rs-wrap row">
      <div class="rs-chips" role="group" aria-label="${attr(t.f_group)}">
        ${chip("", t.f_all, reports.length, true)}
        ${CLASS_ORDER.filter(c => counts[c]).map(c => chip(c, t.cls[c], counts[c], false)).join("\n        ")}
      </div>
      <div class="rs-search" role="search">
        <label for="rsQ" class="rs-sr">${esc(t.f_search_label)}</label>
        ${ICON.search}
        <input type="search" id="rsQ" placeholder="${attr(t.f_search_ph)}" autocomplete="off" spellcheck="false" enterkeyhint="search">
        <button type="button" class="rs-clear" id="rsClear" aria-label="${attr(t.f_clear)}" hidden>×</button>
      </div>
      <div class="rs-count" id="rsCount" aria-live="polite">${esc(tpl(t.f_count_all, { t: reports.length, n: reports.length }))}</div>
    </div>
  </div>`;

    const f = reports[0];
    const fIso = isoDay(f.report_date || f.published_at);
    const fMr = minRead(f, lang, t);
    const featured = `<section class="featured" aria-label="${attr(reportTitle(f, lang))}"><a href="/research/${esc(f.slug)}/">
        <div class="cover"><img src="${attr(coverOf(f, lang)!)}" alt="" width="1672" height="941" fetchpriority="high" decoding="async"></div>
        ${tagsHtml(f, t, 2)}
        <h2>${esc(reportTitle(f, lang))}</h2>
        ${reportSubtitle(f, lang) ? `<p class="sum">${esc(reportSubtitle(f, lang))}</p>` : ""}
        <div class="meta">${fIso ? `<time datetime="${fIso}">${esc(fmtDate(lang, fIso))}</time>` : ""}${fMr ? `<span>${esc(fMr)}</span>` : ""}<span class="go">${esc(t.read)} →</span></div>
      </a></section>`;
    const latestItems = reports.slice(1, 5);
    const latest = `<aside class="latest" aria-labelledby="rsLatestH">
        ${latestItems.length ? `<h2 id="rsLatestH">${esc(t.latest)}</h2><ol>${latestItems.map(r => {
          const iso = isoDay(r.report_date || r.published_at), mr = minRead(r, lang, t);
          return `<li><a href="/research/${esc(r.slug)}/">${tagsHtml(r, t, 1)}<span class="t">${esc(reportTitle(r, lang))}</span><span class="meta">${iso ? `<time datetime="${iso}">${esc(fmtDate(lang, iso))}</time>` : ""}${mr ? `<span>${esc(mr)}</span>` : ""}</span></a></li>`;
        }).join("")}</ol>` : `<h2 id="rsLatestH" class="rs-sr">${esc(t.latest)}</h2>`}
        ${subscribeBox(lang, t)}
      </aside>`;

    const groups: { key: string; items: ReportRow[] }[] = [];
    for (const r of reports) {
      const k = monthKey(r.report_date || r.published_at) || "0000-00";
      const g = groups[groups.length - 1];
      if (g && g.key === k) g.items.push(r); else groups.push({ key: k, items: [r] });
    }
    const archive = groups.map(g => `<section class="month" aria-label="${attr(monthLabel(lang, g.key))}"><div class="m">${esc(monthLabel(lang, g.key))}</div><div class="rows">
      ${g.items.map(r => rowCard(r, lang, t)).join("\n      ")}
    </div></section>`).join("\n    ");

    content = `${bar}
  <div class="rs-wrap">
    <div class="top" id="rsTop">${featured}${latest}</div>
    <div class="list-head" id="rsListHead"><h2 id="rsListTitle">${esc(t.archive)}</h2><span class="label">${esc(t.by_date)}</span></div>
    <div class="cards" id="rsCards">
    ${archive}
    </div>
    <div class="empty" id="rsEmpty" hidden><div class="kicker">// 0</div><h3>${esc(t.empty_title)}</h3><p>${esc(t.empty_text)}</p><button type="button" class="btn" id="rsReset">${esc(t.f_reset)}</button></div>
  </div>`;
  }

  return `${head}
</head>
<body>
  <a class="rs-skip" href="#main-content">${esc(t.skip)}</a>
  <main id="main-content" class="rs-main">
  <section class="index-hero"><div class="rs-wrap">
    <div class="kicker">${esc(t.index_kicker)}</div>
    <h1>${esc(t.index_title)}</h1>
    <p class="lead">${esc(t.index_lead)}</p>
  </div></section>
  ${content}
  <div class="rs-wrap"><section class="nl" aria-labelledby="rsNlH">
    <div><div class="kicker gold">${esc(t.nl_kicker)}</div><h2 id="rsNlH">${esc(t.nl_title)}</h2><p>${esc(t.nl_text)}</p></div>
    <div class="acts"><a class="btn primary" href="${BOT}?start=research_index_${lang}" rel="noopener">${esc(t.nl_trial)}</a><a class="btn ghost" href="/trades.html">${esc(t.nl_track)}</a></div>
  </section></div>
  </main>
  ${jsonData("rsCfg", { all: t.f_count_all, some: t.f_count_some, archive: t.archive, results: t.results })}
  ${jsonData("subCfg", { lang, supaUrl: SUPABASE_URL, supaKey: SUPABASE_ANON_KEY, pending: t.sub_pending, confirming: t.sub_confirming, confirmed: t.sub_confirmed, expired: t.sub_expired, invalid: t.sub_invalid, noConsent: t.sub_no_consent, rate: t.sub_rate, err: t.sub_err })}
  <script>${HDR_JS}</script>
  <script>${INDEX_JS}</script>
  <script>${SUB_JS}</script>
  ${freshScript(lang)}
  <script src="/belfed-analytics.js"></script>
</body>
</html>`;
}


// ---------- chart dimensions ----------
// Charts load lazily; without width/height the page jumps while they arrive and
// TOC links land in the wrong place. Read the size from the image header with a
// small range request and keep it in memory for the life of the isolate.
const DIM_CACHE = new Map<string, [number, number] | null>();
function parseDims(b: Uint8Array): [number, number] | null {
  const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return [u32(16), u32(20)];
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
      const len = (b[i + 2] << 8) | b[i + 3];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [(b[i + 7] << 8) | b[i + 8], (b[i + 5] << 8) | b[i + 6]];
      i += 2 + len;
    }
    return null;
  }
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
    const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (tag === "VP8X") return [1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16))];
    if (tag === "VP8L") { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return [1 + (v & 0x3fff), 1 + ((v >> 14) & 0x3fff)]; }
    if (tag === "VP8 ") return [(b[26] | (b[27] << 8)) & 0x3fff, (b[28] | (b[29] << 8)) & 0x3fff];
  }
  return null;
}
async function fetchDims(url: string): Promise<[number, number] | null> {
  if (DIM_CACHE.has(url)) return DIM_CACHE.get(url)!;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(url, { headers: { Range: "bytes=0-65535" }, signal: ctrl.signal });
    const buf = new Uint8Array(await r.arrayBuffer());
    clearTimeout(timer);
    const d = r.ok ? parseDims(buf) : null;
    const ok = d && d[0] > 0 && d[1] > 0 ? d : null;
    if (ok || r.ok) DIM_CACHE.set(url, ok);
    return ok;
  } catch { return null; }
}
async function chartDims(urls: string[]): Promise<Record<string, [number, number]>> {
  const out: Record<string, [number, number]> = {};
  const uniq = [...new Set(urls)];
  for (let i = 0; i < uniq.length; i += 8) {
    const part = uniq.slice(i, i + 8);
    const res = await Promise.all(part.map(fetchDims));
    part.forEach((u, k) => { const d = res[k]; if (d) out[u] = d; });
  }
  return out;
}

// ---------- report ----------
function labelText(label: string | null | undefined): string {
  return String(label || "").replace(/^\s*\d+\s*[·.:\-]?\s*/, "").trim();
}
function splitCaption(c: string | null | undefined): { text: string; source: string } {
  let s = String(c || "").trim().replace(/^\/\/\s*(chart|график)\s*:\s*/i, "");
  let source = "";
  const m = s.match(/\s*\((?:source|источник)\s*:\s*([^)]*)\)?\s*$/i);
  if (m && m.index !== undefined) { source = m[1].trim(); s = s.slice(0, m.index).trim(); }
  return { text: s, source };
}
interface Fig { src: string; cap: string }
let DIMS: Record<string, [number, number]> = {};
function sectionCharts(s: SectionRow, lang: Lang): Fig[] {
  const out: Fig[] = [];
  if (Array.isArray(s.chart_images) && s.chart_images.length > 0) {
    for (const c of s.chart_images) {
      const src = safeImg(lang === "en" && c.url_en ? c.url_en : c.url);
      if (src) out.push({ src, cap: (lang === "ru" ? c.caption_ru : c.caption_en) || "" });
    }
  } else if (s.chart_image_url) {
    const src = safeImg(s.chart_image_url);
    if (src) out.push({ src, cap: (lang === "ru" ? s.chart_caption_ru : s.chart_caption_en) || "" });
  }
  return out;
}
function figHtml(f: Fig, alt: string, t: Dict): string {
  const { text, source } = splitCaption(f.cap);
  const capFull = [text, source ? `(${t.source}: ${source})` : ""].filter(Boolean).join(" ");
  return `<figure class="chart"><button type="button" data-enlarge data-caption="${attr(capFull)}" aria-label="${attr(t.enlarge_aria + (text ? ": " + text : ""))}"><img src="${attr(f.src)}" alt="${attr(text || alt)}"${DIMS[f.src] ? ` width="${DIMS[f.src][0]}" height="${DIMS[f.src][1]}"` : ""} loading="lazy" decoding="async"><span class="hint" aria-hidden="true">${esc(t.enlarge)}</span></button>${text || source ? `<figcaption class="cap"><span class="cap-k">// ${esc(t.chart)}:</span> ${esc(text)}${source ? ` <span class="cap-src">(${esc(t.source)}: ${esc(source)})</span>` : ""}</figcaption>` : ""}</figure>`;
}

interface Prepared { s: SectionRow; id: string; num: string; heading: string; kicker: string; locked: boolean }

function prepareSections(sections: SectionRow[], lang: Lang, t: Dict): Prepared[] {
  const hasContent = (s: SectionRow) => {
    if (s.is_public === false) return true;
    const h = lang === "ru" ? s.headline_ru : s.headline_en;
    const b = lang === "ru" ? s.body_ru : s.body_en;
    const imgs = Array.isArray(s.chart_images) && s.chart_images.length > 0;
    return Boolean((h && String(h).trim()) || (b && String(b).trim()) || imgs || s.chart_image_url);
  };
  return sections.filter(hasContent).map((s, i) => {
    const num = String(i + 1).padStart(2, "0");
    const lbl = labelText(lang === "ru" ? s.section_label_ru : s.section_label_en);
    const hl = String((lang === "ru" ? s.headline_ru : s.headline_en) || "").trim();
    const heading = hl || lbl || `${t.section} ${num}`;
    const kicker = lbl && lbl.toLowerCase() !== heading.toLowerCase() ? lbl : "";
    return { s, id: `sec-${num}`, num, heading, kicker, locked: s.is_public === false };
  });
}

function renderSectionHtml(p: Prepared, lang: Lang, t: Dict, startPayload: string, first: boolean): string {
  const { s } = p;
  const top = `<div class="sec-num"><span>${p.num}</span>${p.kicker ? `<span class="sec-lbl">${esc(p.kicker)}</span>` : ""}${p.locked ? `<span class="tag type">${ICON.lock} ${esc(t.locked_label)}</span>` : ""}</div><h2>${esc(p.heading)}</h2>`;
  if (p.locked) {
    const tx = lang === "ru" ? s.teaser_ru : s.teaser_en;
    const imgs = (s.teaser_imgs || []).slice(0, 2);
    const hw = lang === "ru" ? (s.hidden_words_ru || 0) : (s.hidden_words_en || 0);
    const words = hw >= 30 ? t.locked_words(Math.round(hw / 10) * 10) : "";
    const charts = s.hidden_charts ? t.locked_charts(s.hidden_charts) : "";
    return `<section class="rp-sec locked${first ? " first" : ""}" id="${p.id}" aria-labelledby="${p.id}-h">
        ${top.replace("<h2>", `<h2 id="${p.id}-h">`)}
        ${tx ? `<div class="fade"><p>${esc(tx)}</p></div>` : ""}
        ${imgs.length ? `<div class="figs" aria-hidden="true">${imgs.map(u => `<div class="fig"><img src="${attr(u)}" alt="" loading="lazy" decoding="async" width="64" height="40"><span>${ICON.lock} ${esc(t.chart_locked)}</span></div>`).join("")}</div>` : ""}
        <div class="gate"><span class="k">${ICON.lock} ${esc(t.locked_label)}</span><h3>${esc(t.locked_title)}</h3><p>${esc(tpl(t.locked_text, { w: words, c: charts }))}</p>
          <div class="row"><a class="btn primary" href="${BOT}?start=${startPayload}_gated" rel="noopener">${esc(t.locked_cta)}</a><a class="rs-alt" href="/members.html">${esc(t.locked_login)} →</a></div>
          <span class="fine">${esc(t.locked_fine)}</span></div>
      </section>`;
  }
  const body = lang === "ru" ? s.body_ru : s.body_en;
  const charts = sectionCharts(s, lang).map(f => figHtml(f, p.heading, t)).join("\n");
  return `<section class="rp-sec${first ? " first" : ""}" id="${p.id}" aria-labelledby="${p.id}-h">
        ${top.replace("<h2>", `<h2 id="${p.id}-h">`)}
        ${renderBody(body)}
        ${charts}
      </section>`;
}

function takeawaysFor(prepared: Prepared[], lang: Lang): string[] {
  const pub = prepared.filter(p => !p.locked);
  const body = (p: Prepared) => lang === "ru" ? p.s.body_ru : p.s.body_en;
  const concl = pub.find(p => p.s.is_conclusion && wordCount(body(p)) > 20);
  let items: string[];
  if (concl) items = sentences(body(concl)).slice(0, 4);
  else items = pub.filter(p => !p.s.is_conclusion).map(p => sentences(body(p))[0] || "").filter(Boolean).slice(0, 5);
  items = items.map(x => clip(x));
  return items.length >= 2 ? items : [];
}

function tocHtml(prepared: Prepared[], t: Dict, idSuffix: string): string {
  return `<nav class="toc" aria-label="${attr(t.toc)}${idSuffix}"><p class="toc-h">${esc(t.toc)}</p><ol>${prepared.map(p =>
    `<li><a href="#${p.id}"><span class="n">${p.num}</span><span>${esc(p.heading)}${p.locked ? `<span class="lk" title="${attr(t.locked_label)}">${ICON.lock}</span>` : ""}</span></a></li>`).join("")}</ol></nav>`;
}

const REPORT_JS = String.raw`(function(){
  var C=JSON.parse(document.getElementById('rpCfg').textContent);
  // copy link
  [].forEach.call(document.querySelectorAll('[data-copy]'),function(b){
    b.addEventListener('click',function(){
      var url=C.url; var lbl=b.querySelector('span');
      function done(){var old=lbl.textContent; lbl.textContent=C.copied; b.setAttribute('data-done',''); setTimeout(function(){lbl.textContent=old; b.removeAttribute('data-done');},1800);}
      function fallback(){try{var ta=document.createElement('textarea'); ta.value=url; ta.setAttribute('readonly',''); ta.style.position='fixed'; ta.style.opacity='0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);}catch(e){} done();}
      if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done,fallback); else fallback();
    });
  });
  // lightbox
  var dlg=document.getElementById('rsLb');
  if(dlg&&dlg.showModal){
    var lbImg=dlg.querySelector('img'), lbCap=dlg.querySelector('figcaption span'), opener=null;
    [].forEach.call(document.querySelectorAll('[data-enlarge]'),function(btn){
      btn.addEventListener('click',function(){var img=btn.querySelector('img'); lbImg.src=img.currentSrc||img.src; lbImg.alt=img.alt; lbCap.textContent=btn.getAttribute('data-caption')||''; opener=btn; dlg.showModal();});
    });
    dlg.querySelector('.lb-close').addEventListener('click',function(){dlg.close();});
    dlg.addEventListener('click',function(e){if(e.target===dlg) dlg.close();});
    dlg.addEventListener('close',function(){lbImg.removeAttribute('src'); if(opener) opener.focus();});
  } else {
    [].forEach.call(document.querySelectorAll('[data-enlarge]'),function(btn){btn.addEventListener('click',function(){window.open(btn.querySelector('img').src,'_blank','noopener');});});
  }
  // reading progress
  var bar=document.getElementById('rsProgress'), wrap=bar&&bar.parentNode, body=document.querySelector('.rp-body'), raf=0;
  function prog(){raf=0; if(!body||!bar) return; var r=body.getBoundingClientRect(); var total=r.height-window.innerHeight*0.6; var p=Math.min(1,Math.max(0,(-r.top+window.innerHeight*0.2)/Math.max(1,total))); bar.style.transform='scaleX('+p.toFixed(4)+')'; wrap.setAttribute('aria-valuenow',Math.round(p*100));}
  window.addEventListener('scroll',function(){if(!raf) raf=requestAnimationFrame(prog);},{passive:true}); window.addEventListener('resize',prog); prog();
  // scroll-spy (desktop + mobile TOC)
  var links=[].slice.call(document.querySelectorAll('.toc a[href^="#"]')), map={};
  links.forEach(function(a){var id=a.getAttribute('href').slice(1); (map[id]=map[id]||[]).push(a);});
  var secs=Object.keys(map).map(function(id){return document.getElementById(id);}).filter(Boolean), curId='', sraf=0;
  function spy(){sraf=0; var line=window.innerHeight*0.3, id=secs.length?secs[0].id:'';
    for(var i=0;i<secs.length;i++){ if(secs[i].getBoundingClientRect().top<=line) id=secs[i].id; else break; }
    if(id!==curId){curId=id; links.forEach(function(a){a.removeAttribute('aria-current');}); (map[id]||[]).forEach(function(a){a.setAttribute('aria-current','location');});}
  }
  if(secs.length){window.addEventListener('scroll',function(){if(!sraf) sraf=requestAnimationFrame(spy);},{passive:true}); window.addEventListener('resize',spy); spy();}
  [].forEach.call(document.querySelectorAll('details.toc-mobile a'),function(a){a.addEventListener('click',function(){a.closest('details').open=false;});});
  // one dismissible sticky banner
  var ban=document.getElementById('rsBanner');
  if(ban){
    var dismissed=false; try{dismissed=sessionStorage.getItem('bf_research_banner_dismissed')==='1';}catch(e){}
    if(!dismissed){
      var onS=function(){var h=document.documentElement; var s=(h.scrollTop||document.body.scrollTop)/Math.max(1,h.scrollHeight-h.clientHeight); if(s>0.25){ban.hidden=false; window.removeEventListener('scroll',onS);}};
      window.addEventListener('scroll',onS,{passive:true});
      ban.querySelector('button').addEventListener('click',function(){ban.hidden=true; try{sessionStorage.setItem('bf_research_banner_dismissed','1');}catch(e){}});
    }
  }
  // email lead form (landing-lead-create)
  var form=document.getElementById('leadForm');
  if(form){
    var ok=document.getElementById('leadOk'), err=document.getElementById('leadErr');
    form.addEventListener('submit',function(e){
      e.preventDefault();
      var btn=document.getElementById('leadSubmit');
      var email=(document.getElementById('leadEmail').value||'').trim().toLowerCase();
      var consent=document.getElementById('leadConsent').checked;
      var hp=document.getElementById('leadHoneypot').value||'';
      if(!email) return;
      ok.hidden=true; err.hidden=true;
      if(!consent){err.textContent=C.noConsent; err.hidden=false; return;}
      var label=btn.textContent; btn.disabled=true; btn.textContent='…';
      var payload={email:email,ticker:C.leadTicker,asset_class:null,timeframe:null,note:C.leadNote,consent:consent,lang:C.lang,source:C.leadSource,website:hp};
      if(window.BelfedAnalytics&&window.BelfedAnalytics.utmFields){var u=window.BelfedAnalytics.utmFields(); for(var k in u) if(Object.prototype.hasOwnProperty.call(u,k)) payload[k]=u[k];}
      fetch(C.supaUrl+'/functions/v1/landing-lead-create',{method:'POST',headers:{'Content-Type':'application/json','apikey':C.supaKey,'Authorization':'Bearer '+C.supaKey},body:JSON.stringify(payload)})
        .then(function(r){return r.json().then(function(d){return {status:r.status,body:d};});})
        .then(function(res){
          btn.disabled=false; btn.textContent=label;
          if(res.body&&(res.body.ok||res.body.reason==='dup')){ if(window.belfedTrack) window.belfedTrack('research_lead_submitted',{report:C.leadNote}); form.reset(); ok.hidden=false; }
          else { err.textContent=C.err; err.hidden=false; }
        })
        .catch(function(){btn.disabled=false; btn.textContent=label; err.textContent=C.err; err.hidden=false;});
    });
  }
})();`;

function miniCard(r: ReportRow, lang: Lang, t: Dict): string {
  const iso = isoDay(r.report_date || r.published_at), mr = minRead(r, lang, t);
  return `<a class="rc" href="/research/${esc(r.slug)}/"><div class="cover"><img src="${attr(coverOf(r, lang)!)}" alt="" loading="lazy" decoding="async" width="1672" height="941"></div><div><div class="meta">${iso ? `<time datetime="${iso}">${esc(fmtDate(lang, iso))}</time>` : ""}${mr ? `<span>${esc(mr)}</span>` : ""}</div></div><h3>${esc(reportTitle(r, lang))}</h3></a>`;
}

function renderReport(lang: Lang, r: ReportRow, sections: SectionRow[], others: ReportRow[]): string {
  const t = T[lang];
  const dom = domain(lang);
  const title = reportTitle(r, lang);
  const sub = reportSubtitle(r, lang);
  const canonical = `https://${dom}/research/${r.slug}/`;
  const heroCover = coverOf(r, lang);
  const ogImage = heroCover || `https://${dom}/og-belfed.png`;
  const dateISO = r.report_date || r.published_at;
  const day = isoDay(dateISO);
  const dateStr = fmtDate(lang, dateISO);
  const slugAd = r.slug.replace(/-/g, "_");
  const startPayload = `research_${slugAd}_${lang}`;
  const metaTitle = `${title}${lang === "ru" ? " | Обзоры рынков BelFed" : " | Belfed Market Commentary"}`;
  const metaDesc = sub || title;
  const classes = reportClasses(r);
  const head = headBase(lang, {
    title: metaTitle, description: metaDesc, canonical,
    ogTitle: title, ogDescription: sub || metaDesc, ogImage, ogType: "article",
    altPath: `/research/${r.slug}/`,
    preloadImg: heroCover,
    jsonLd: [
      orgNode(lang),
      {
        "@context": "https://schema.org",
        "@type": "Article",
        "@id": canonical,
        mainEntityOfPage: canonical,
        headline: title,
        description: metaDesc,
        image: [ogImage],
        inLanguage: lang === "ru" ? "ru-RU" : "en-US",
        datePublished: dateISO || undefined,
        dateModified: r.published_public_at || r.published_at || dateISO || undefined,
        author: { "@id": ORG_ID },
        publisher: { "@id": ORG_ID },
        keywords: [...(r.asset_classes || []), ...(r.sectors || []), ...(r.tags || []).map(cleanTag)].filter(Boolean).join(", ") || undefined,
        isAccessibleForFree: true,
      },
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: lang === "ru" ? "Главная" : "Home", item: `https://${dom}/` },
          { "@type": "ListItem", position: 2, name: t.index_title, item: `https://${dom}/research/` },
          { "@type": "ListItem", position: 3, name: title, item: canonical },
        ],
      },
    ],
  });

  const prepared = prepareSections(sections, lang, t);
  const words = prepared.filter(p => !p.locked).reduce((n, p) => n + wordCount(lang === "ru" ? p.s.body_ru : p.s.body_en), 0) + wordCount(sub);
  const minutes = readMinutes(words, lang);
  const takeaways = takeawaysFor(prepared, lang);

  // Mid CTA after roughly half of the public sections (only on longer reports).
  const publicIdx = prepared.map((p, i) => p.locked ? -1 : i).filter(i => i >= 0);
  const midAfter = publicIdx.length >= 3 ? publicIdx[Math.floor(publicIdx.length / 2) - 1] : -1;
  const midCta = `<aside class="cta-mid" aria-labelledby="rsMidH"><div><div class="kicker gold">${esc(t.mid_kicker)}</div><h3 id="rsMidH">${esc(t.mid_title)}</h3><p>${esc(t.mid_text)}</p></div><div class="col"><a class="btn primary" href="${TG_FREE[lang]}" rel="noopener">${esc(t.mid_btn)}</a><a class="rs-alt" href="/trades.html">${esc(t.mid_alt)} →</a></div></aside>`;
  const sectionsHtml = prepared.map((p, i) => renderSectionHtml(p, lang, t, startPayload, i === 0) + (i === midAfter ? "\n      " + midCta : "")).join("\n      ");

  // Kicker: report kicker plus asset classes.
  const kicker = [t.report_kicker, ...classes.slice(0, 2).map(c => t.cls[c])].join(" · ");
  const seen = new Set<string>();
  const topicTags = [...(r.sectors || []), ...(r.tags || [])].map(cleanTag).filter(Boolean)
    .filter(x => { const k = x.toLowerCase(); if (seen.has(k) || classes.some(c => t.cls[c].toLowerCase() === k)) return false; seen.add(k); return true; }).slice(0, 5);

  // Custom per-report CTA (written by the author) takes the final block.
  const customH = (lang === "ru" ? r.cta_headline_ru : r.cta_headline_en) || "";
  const customB = (lang === "ru" ? r.cta_body_ru : r.cta_body_en) || "";
  const hasCustom = Boolean(customH.trim());
  const finalBody = hasCustom && customB.trim()
    ? customB.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean).map(x => `<p>${esc(x)}</p>`).join("")
    : `<p>${esc(t.final_text)}</p>`;
  const trialBtn = `<a class="btn ${hasCustom ? "primary" : "ghost"}" href="${BOT}?start=${startPayload}_final" rel="noopener">${esc(t.final_trial)}</a>`;
  const tgBtn = `<a class="btn ${hasCustom ? "ghost" : "primary"}" href="${TG_FREE[lang]}" rel="noopener">${esc(t.final_tg)}</a>`;

  const leadTicker = (r.tags && r.tags[0]) ? cleanTag(r.tags[0]).toUpperCase().replace(/[^A-Z0-9]/g, "_") : slugAd.toUpperCase();
  const leadNote = `research_${slugAd}`;

  // Prev (older) / next (newer) and related by asset class.
  const list = others.filter(o => coverOf(o, lang));
  const idx = list.findIndex(o => o.slug === r.slug);
  const older = idx >= 0 ? list[idx + 1] : list.find(o => (o.report_date || "") < (r.report_date || ""));
  const newer = idx > 0 ? list[idx - 1] : undefined;
  const pool = list.filter(o => o.slug !== r.slug);
  const score = (o: ReportRow) => reportClasses(o).filter(c => classes.includes(c)).length;
  const related = pool.filter(o => score(o) > 0).sort((a, b) => score(b) - score(a) || String(b.report_date).localeCompare(String(a.report_date))).slice(0, 3);
  for (const o of pool) { if (related.length >= 3) break; if (!related.includes(o)) related.push(o); }

  const shareUrl = encodeURIComponent(canonical), shareText = encodeURIComponent(title);
  const meta = [
    day ? `<span><time datetime="${day}">${esc(dateStr)}</time></span>` : "",
    `<span>${esc(t.brand)}</span>`,
    `<span>${esc(tpl(t.min_read, { n: minutes }))}</span>`,
    `<span>${esc(typeLabel(r, t))}</span>`,
  ].filter(Boolean).join(`<span class="sep" aria-hidden="true">·</span>`);

  return `${head}
</head>
<body>
  <a class="rs-skip" href="#main-content">${esc(t.skip)}</a>
  <div class="rs-progress" role="progressbar" aria-label="${attr(t.progress)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div id="rsProgress"></div></div>
  <main id="main-content" class="rs-main">
    <div class="rs-wrap rp-crumb"><a href="/research/">← ${esc(t.crumb)}</a></div>
    <header class="rp-hero"><div class="rs-wrap">
      <div class="inner">
        <div class="kicker">${esc(kicker)}</div>
        <h1>${esc(title)}</h1>
        ${sub ? `<p class="sub">${esc(sub)}</p>` : ""}
        <div class="meta">${meta}</div>
        <div class="tags"><span class="tag type">${esc(typeLabel(r, t))}</span>${classes.map(c => `<span class="tag cls">${esc(t.cls[c])}</span>`).join("")}${topicTags.map(x => `<span class="tag">${esc(x)}</span>`).join("")}</div>
        <div class="actions" role="group" aria-label="${attr(t.share)}">
          <button type="button" class="btn sm" data-copy>${ICON.link} <span>${esc(t.copy)}</span></button>
          <a class="btn sm ghost" href="https://t.me/share/url?url=${shareUrl}&amp;text=${shareText}" target="_blank" rel="noopener">${esc(t.share_tg)}</a>
          <a class="btn sm ghost" href="https://x.com/intent/post?url=${shareUrl}&amp;text=${shareText}" target="_blank" rel="noopener">${esc(t.share_x)}</a>
        </div>
        <p class="disc-line"><span>${esc(t.disc_short)} <a href="/disclaimer.html">${esc(t.disc_link)} →</a></span></p>
      </div>
      ${heroCover ? `<figure class="rp-cover"><img src="${attr(heroCover)}" alt="${attr(title)}" width="1672" height="941" fetchpriority="high" decoding="async"></figure>` : ""}
    </div></header>
    <div class="rs-wrap rp-layout">
      <article class="rp-body" aria-labelledby="rpTitle">
        <h2 id="rpTitle" class="rs-sr">${esc(title)}</h2>
        ${prepared.length > 1 ? `<details class="toc-mobile"><summary>${esc(t.toc)}</summary>${tocHtml(prepared, t, "")}</details>` : ""}
        ${takeaways.length ? `<section class="takeaways" aria-labelledby="rsTk"><div class="head"><span class="kicker" id="rsTk">// ${esc(t.takeaways)}</span><span class="label">${takeaways.length}</span></div><ol>${takeaways.map(x => `<li><span>${esc(x)}</span></li>`).join("")}</ol></section>` : ""}
      ${sectionsHtml}
        <section class="cta-final" id="stay-in-loop" aria-labelledby="rsFinalH">
          <div class="kicker gold">${esc(t.final_kicker)}</div>
          <h2 id="rsFinalH">${esc(hasCustom ? customH : t.final_title)}</h2>
          ${finalBody}
          <div class="acts">${hasCustom ? trialBtn + tgBtn : tgBtn + trialBtn}</div>
          <div class="lead">
            <div class="kicker">${esc(t.lead_kicker)}</div>
            <h3>${esc(t.lead_title)}</h3>
            <p>${esc(t.lead_text)}</p>
            <form id="leadForm" novalidate>
              <div class="field"><label for="leadEmail" class="rs-sr">${esc(t.lead_email_label)}</label><input type="email" id="leadEmail" placeholder="${attr(t.lead_email_placeholder)}" required autocomplete="email" inputmode="email"><button type="submit" class="submit" id="leadSubmit">${esc(t.lead_submit)} →</button></div>
              <label class="consent"><input type="checkbox" id="leadConsent"><span>${esc(t.lead_consent)}</span></label>
              <div class="hp" aria-hidden="true"><input type="text" id="leadHoneypot" tabindex="-1" autocomplete="off"></div>
              <div class="msg ok" id="leadOk" role="status" hidden>${esc(t.lead_ok)}</div>
              <div class="msg err" id="leadErr" role="alert" hidden>${esc(t.lead_err)}</div>
            </form>
          </div>
        </section>
        <section class="trust" aria-label="${attr(t.author)}">
          <div><span class="k">${esc(t.author)}</span><strong>${esc(t.brand)}</strong>${day ? `<br>${esc(t.published)} <time datetime="${day}">${esc(dateStr)}</time>` : ""}</div>
          <div><span class="k">${esc(t.trust_track)}</span>${esc(t.trust_track_text)} <a href="/trades.html">${esc(t.trust_track_link)} →</a></div>
          <div class="disc"><strong>${esc(t.disclaimer_label)}</strong> ${t.disclaimer_body}</div>
        </section>
      </article>
      ${prepared.length > 1 ? `<aside class="rp-aside">${tocHtml(prepared, t, " ")}<p class="toc-cta">${esc(t.banner_text)} <a href="${TG_FREE[lang]}" rel="noopener">${esc(t.banner_btn)} →</a></p></aside>` : ""}
    </div>
    <div class="rs-wrap">
      ${older || newer ? `<nav class="pn" aria-label="${attr(t.prev + " / " + t.next)}">
        ${older ? `<a class="pv" href="/research/${esc(older.slug)}/" rel="prev"><span class="k">← ${esc(t.prev)}</span><span class="t">${esc(reportTitle(older, lang))}</span><span class="d">${esc(fmtDate(lang, older.report_date || older.published_at))}</span></a>` : ""}
        ${newer ? `<a class="nx" href="/research/${esc(newer.slug)}/" rel="next"><span class="k">${esc(t.next)} →</span><span class="t">${esc(reportTitle(newer, lang))}</span><span class="d">${esc(fmtDate(lang, newer.report_date || newer.published_at))}</span></a>` : ""}
      </nav>` : ""}
      ${related.length ? `<section class="related" aria-labelledby="rsRelH"><div class="list-head"><h2 id="rsRelH">${esc(t.related)}</h2><span class="label">${esc(t.related_sub)}</span></div><div class="grid">${related.map(o => miniCard(o, lang, t)).join("")}</div></section>` : ""}
    </div>
  </main>
  <div class="rs-banner" id="rsBanner" role="region" aria-label="${attr(t.banner_text)}" hidden>
    <span>${esc(t.banner_text)} <a href="${TG_FREE[lang]}" rel="noopener">${esc(t.banner_btn)}</a></span>
    <button type="button">${esc(t.banner_close)}</button>
  </div>
  <dialog class="rs-lb" id="rsLb" aria-label="${attr(t.chart)}"><figure><img alt=""><figcaption><span></span><button type="button" class="lb-close">${esc(t.close)}</button></figcaption></figure></dialog>
  ${jsonData("rpCfg", { url: canonical, copied: t.copied, noConsent: t.lead_no_consent, err: t.lead_err, supaUrl: SUPABASE_URL, supaKey: SUPABASE_ANON_KEY, leadTicker, leadNote, leadSource: leadNote, lang })}
  <script>${HDR_JS}</script>
  <script>${REPORT_JS}</script>
  <script src="/belfed-analytics.js"></script>
</body>
</html>`;
}

function notFoundPage(lang: Lang): string {
  const t = T[lang];
  const dom = domain(lang);
  const head = headBase(lang, {
    title: `${t.nf_title} | ${t.brand}`,
    description: t.index_meta_desc,
    canonical: `https://${dom}/research/`,
    ogTitle: t.nf_title,
    ogDescription: t.index_meta_desc,
    ogImage: `https://${dom}/og-belfed.png`,
    robots: "noindex, follow",
  });
  return `${head}
</head>
<body>
  <a class="rs-skip" href="#main-content">${esc(t.skip)}</a>
  <main id="main-content" class="rs-main"><div class="rs-wrap"><section class="nf">
    <div class="kicker">// 404</div>
    <h1>${esc(t.nf_title)}</h1>
    <p>${esc(t.nf_text)}</p>
    <a class="btn primary" href="/research/">${esc(t.nf_back)} →</a>
  </section></div></main>
  <script>${HDR_JS}</script>
</body>
</html>`;
}

const REPORT_COLUMNS = ["id","slug","report_date","report_type","title_ru","title_en","subtitle_ru","subtitle_en","asset_classes","sectors","tags","cover_image_url","cover_image_url_ru","cover_image_url_en","published_at","published_public_at","cta_headline_ru","cta_headline_en","cta_body_ru","cta_body_en","cta_ticker_teaser_ru","cta_ticker_teaser_en"].join(", ");
const SECTION_PUBLIC_COLUMNS = ["id","position","is_conclusion","is_public","section_label_ru","section_label_en","headline_ru","headline_en","body_ru","body_en","chart_image_url","chart_caption_ru","chart_caption_en","chart_images"].join(", ");
const CARD_COLUMNS = ["id","slug","report_date","report_type","title_ru","title_en","subtitle_ru","subtitle_en","asset_classes","sectors","tags","cover_image_url","cover_image_url_ru","cover_image_url_en","published_at","published_public_at"].join(", ");

function htmlResponse(body: string, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
      "vary": "accept-language",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      // public HTML; lets belfed.ru/.com fetch fresh pages before the static prerender catches up
      "access-control-allow-origin": "*",
      ...extraHeaders,
    },
  });
}

function parseLang(v: string | null): Lang { return v === "ru" ? "ru" : "en"; }

async function listCards(): Promise<ReportRow[]> {
  const { data, error } = await supa
    .from("analytics_reports").select(CARD_COLUMNS)
    .eq("is_public", true).eq("status", "published")
    .order("report_date", { ascending: false })
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(50);
  if (error) throw new Error(error.message);
  const reports = (data || []) as unknown as ReportRow[];
  // Reading time per report: public section text only.
  const ids = reports.map(r => r.id);
  if (ids.length) {
    const { data: secs, error: sErr } = await supa
      .from("analytics_sections").select("report_id, is_public, body_ru, body_en").in("report_id", ids);
    if (!sErr && secs) {
      const w: Record<string, { ru: number; en: number }> = {};
      for (const s of secs as Array<{ report_id: string; is_public: boolean; body_ru: string | null; body_en: string | null }>) {
        if (s.is_public === false) continue;
        const o = w[s.report_id] || (w[s.report_id] = { ru: 0, en: 0 });
        o.ru += wordCount(s.body_ru); o.en += wordCount(s.body_en);
      }
      for (const r of reports) {
        const o = w[r.id];
        if (o) { r.words_ru = o.ru + wordCount(r.subtitle_ru); r.words_en = o.en + wordCount(r.subtitle_en); }
      }
    }
  }
  return reports;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*" } });
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response("method_not_allowed", { status: 405 });
  }
  const url = new URL(req.url);
  const lang = parseLang(url.searchParams.get("lang"));
  const slug = (url.searchParams.get("slug") || "").trim();
  try {
    if (!slug) {
      return htmlResponse(renderIndex(lang, await listCards()), 200);
    }
    const { data: reports, error: rErr } = await supa
      .from("analytics_reports").select(REPORT_COLUMNS)
      .eq("slug", slug).eq("is_public", true).eq("status", "published").limit(1);
    if (rErr) return htmlResponse(`<h1>Server error</h1><pre>${esc(rErr.message)}</pre>`, 500, { "cache-control": "no-store" });
    const report = ((reports ?? []) as unknown as ReportRow[])[0];
    if (!report) return htmlResponse(notFoundPage(lang), 404, { "cache-control": "public, max-age=60" });
    const [{ data: sections, error: sErr }, others] = await Promise.all([
      supa.from("analytics_sections").select(SECTION_PUBLIC_COLUMNS).eq("report_id", report.id).order("position", { ascending: true }),
      listCards().catch(() => [] as ReportRow[]),
    ]);
    if (sErr) return htmlResponse(`<h1>Server error</h1><pre>${esc(sErr.message)}</pre>`, 500, { "cache-control": "no-store" });
    const secs = ((sections || []) as unknown as Record<string, unknown>[]).map((s) => {
      if (s.is_public === false) {
        const ci = Array.isArray(s.chart_images) ? (s.chart_images as Array<{ url?: string; url_en?: string }>).map(c => c && (lang === "en" && c.url_en ? c.url_en : c.url)) : [];
        const full = (ci.length ? ci : [s.chart_image_url as string | null]).filter(Boolean) as string[];
        const urls = full.map(u => teaserThumb(u)).filter(Boolean) as string[];
        const tRu = teaserText(s.body_ru as string), tEn = teaserText(s.body_en as string);
        // Only derived numbers and the short teaser leave this function.
        return { id: s.id, position: s.position, is_conclusion: s.is_conclusion, is_public: false,
          section_label_ru: s.section_label_ru, section_label_en: s.section_label_en,
          headline_ru: s.headline_ru, headline_en: s.headline_en,
          teaser_ru: tRu, teaser_en: tEn, teaser_imgs: urls,
          hidden_words_ru: Math.max(0, wordCount(s.body_ru as string) - wordCount(tRu)),
          hidden_words_en: Math.max(0, wordCount(s.body_en as string) - wordCount(tEn)),
          hidden_charts: full.length } as SectionRow;
      }
      return s as unknown as SectionRow;
    });
    const figUrls = secs.filter(x => x.is_public !== false).flatMap(x => sectionCharts(x, lang).map(f => f.src));
    DIMS = await chartDims(figUrls).catch(() => ({}));
    return htmlResponse(renderReport(lang, report, secs, others), 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return htmlResponse(`<h1>Server error</h1><pre>${esc(msg)}</pre>`, 500, { "cache-control": "no-store" });
  }
});

// research-render v3 — SSR HTML for /research/ index and /research/<slug>/ pages
//
// v3 (2026-09-15): SEO hardening for the static prerender pipeline.
//   - hreflang alternates (ru / en / x-default) on the index and on every report,
//     pointing at the same slug across belfed.ru and belfed.com.
//   - JSON-LD: Organization + WebSite on the index, Article + BreadcrumbList on
//     reports (Article uses published_public_at as datePublished).
//   - The "report not found" page is now noindex,follow.
//
// One edge function that renders both languages (ru/en) for both surfaces:
//   /functions/v1/research-render?lang=ru                → RU index
//   /functions/v1/research-render?lang=en                → EN index
//   /functions/v1/research-render?lang=ru&slug=<slug>    → RU report
//   /functions/v1/research-render?lang=en&slug=<slug>    → EN report
//
// verify_jwt=false, cache-friendly (5 min CDN cache).
//
// Compliance P0 note: the lead form uses source='research_<slug>' and MUST NOT be
// wired to marketing sequences until landing-lead-create split-consent rollout.

import { createClient } from "jsr:@supabase/supabase-js@2";

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
}

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
  chart_images?: Array<{ url: string; url_en?: string; caption_ru?: string; caption_en?: string }> | null;
  teaser_ru?: string;
  teaser_en?: string;
  teaser_imgs?: string[];
}

const T = {
  ru: {
    nav_home: "Главная", nav_track: "История сделок", nav_research: "Исследования",
    nav_products: "Тарифы", nav_about: "О нас", nav_lang: "EN",
    nav_cta: "14 дней бесплатно", skip: "Перейти к содержимому",
    index_kicker: "// Публичные исследования BelFed", index_title: "Исследования",
    index_subtitle: "Независимые отчёты BelFed Analytics по секторам, отдельным темам и макро-циклам.",
    index_empty: "Пока нет публичных отчётов. Загляните позже.",
    f_all: "Все", f_group: "Класс активов", f_search_label: "Поиск по отчётам", f_search_ph: "Поиск: Nvidia, биткоин, ФРС",
    f_clear: "Очистить поиск", f_none: "Ничего не найдено.", f_reset: "Сбросить фильтры",
    f_count: (n: number, total: number) => n === total ? `Отчётов: ${total}` : `Найдено: ${n} из ${total}`,
    cls: { equities: "Акции", crypto: "Криптовалюты", macro: "Макро", rates: "Облигации и ставки", commodities: "Сырьё", fx: "Валюты" } as Record<string, string>,
    index_meta_title: "Исследования | BelFed Analytics",
    index_meta_desc: "Независимые исследовательские отчёты BelFed Analytics: акции, крипта, макро, сектора и отдельные темы.",
    report_reading: "Время чтения", report_author: "Автор", report_coverage: "Покрытие",
    report_kicker_prefix: "Исследовательский отчёт · ",
    report_date_fmt: (d: string) => formatDateRu(d),
    key_takeaways: "Ключевые выводы",
    gated_label: "Доступно подписчикам",
    gated_body: "Продолжение раздела и графики открыты подписчикам. Первые 14 дней бесплатно.",
    gated_btn: "Подписаться и читать полностью →",
    cta_default_headline: "Мы уже определили точки входа по тикерам из этого отчёта.",
    cta_default_body: "Уровни, стопы и цели публикуются в закрытой части сервиса и в Telegram в момент срабатывания сетапа. Начните 14-дневный триал и получите доступ до того, как мы откроем первую позицию по этой теме. Карта не требуется.",
    cta_kicker: "// От анализа к позициям",
    cta_start_trial: "Открыть 14-дневный триал →",
    cta_notify_email: "Просто уведомите меня по email",
    sticky_body: "Мы уже определили точки входа по тикерам из этого отчёта.",
    sticky_link: "Открыть 14-дневный триал →", sticky_close: "Закрыть",
    final_kicker: "// Два способа быть в курсе",
    final_title: "Вы прочитали тезис. Как теперь на нём торговать.",
    final_lead: "Закрытая часть BelFed публикует входы, стопы и цели по этой теме в момент срабатывания: в Telegram и на дашборде. Каждая закрытая сделка навсегда попадает в наш публичный журнал.",
    track_ytd_label: "YTD 2026 · 87 сделок · win rate ~62%",
    track_2025_label: "2025 · 61 сделка",
    track_all_label: "Каждая сделка публично",
    path_1_label: "Вариант 1 · Полный доступ",
    path_1_title: "Открыть 14-дневный триал",
    path_1_body: "Полный доступ к закрытой части, оповещения в Telegram, возможность заказать анализ любого актива. Без карты. Отмена в один клик.",
    path_1_cta: "Открыть 14-дневный триал →",
    path_2_label: "Вариант 2 · Только оповещения",
    path_2_title: "Получить уведомление, когда откроем позицию",
    path_2_body: "Одно короткое письмо, когда мы совершим сделку по этой теме. Отписка в один клик.",
    lead_email_placeholder: "you@example.com",
    lead_consent: "Я согласен получать исследовательские материалы BelFed и уведомления по этой теме по email. Одно короткое письмо за раз, отписка в один клик.",
    lead_submit: "Уведомить меня →",
    lead_ok: "Готово. Мы напишем вам, когда сработает сделка по этой теме.",
    lead_err: "Что-то пошло не так. Попробуйте, пожалуйста, ещё раз через минуту.",
    lead_no_consent: "Пожалуйста, отметьте согласие, чтобы продолжить.",
    disclaimer_label: "Дисклеймер.",
    disclaimer_body: 'Данный отчёт является независимым рыночным исследованием BelFed Analytics, публикуемым в информационных и образовательных целях. Он не является инвестиционной рекомендацией, офертой или приглашением к совершению сделок с ценными бумагами, цифровыми активами или производными инструментами, и не учитывает целей, финансового положения или потребностей конкретного читателя. Изложенные взгляды отражают наш анализ на дату публикации и могут изменяться без уведомления. Любое решение действовать на основе этого материала остаётся полностью на ответственности читателя. Торговля и инвестиции сопряжены с риском убытков, вплоть до потери всего капитала. Полный текст: <a href="/disclaimer.html">дисклеймер</a> и <a href="/privacy.html">политика конфиденциальности</a>.',
    footer_copyright: "© 2025–2026 BelFed Analytics. Все права защищены.",
    footer_research: "Исследования", footer_disclaimer: "Дисклеймер",
    footer_privacy: "Конфиденциальность", footer_terms: "Оферта",
    footer_alt_site: "EN версия", footer_note: "Не является финансовой рекомендацией.",
    card_reading: "мин", author_name: "BelFed Analytics",
  },
  en: {
    nav_home: "Home", nav_track: "Track record", nav_research: "Research",
    nav_products: "Products", nav_about: "About", nav_lang: "RU",
    nav_cta: "Start 14-day trial", skip: "Skip to main content",
    index_kicker: "// Belfed public research", index_title: "Research",
    index_subtitle: "Independent Belfed Analytics reports on sectors, single-name themes, and macro cycles.",
    index_empty: "No public reports yet. Check back soon.",
    f_all: "All", f_group: "Asset class", f_search_label: "Search reports", f_search_ph: "Search: Nvidia, bitcoin, Fed",
    f_clear: "Clear search", f_none: "No reports match.", f_reset: "Reset filters",
    f_count: (n: number, total: number) => n === total ? `${total} reports` : `${n} of ${total} reports`,
    cls: { equities: "Equities", crypto: "Crypto", macro: "Macro", rates: "Rates & credit", commodities: "Commodities", fx: "FX" } as Record<string, string>,
    index_meta_title: "Research | Belfed Analytics",
    index_meta_desc: "Independent Belfed Analytics research reports: equities, crypto, macro, sectors, and single-name themes.",
    report_reading: "Reading time", report_author: "Author", report_coverage: "Coverage",
    report_kicker_prefix: "Research report · ",
    report_date_fmt: (d: string) => formatDateEn(d),
    key_takeaways: "Key takeaways",
    gated_label: "Available to subscribers",
    gated_body: "The rest of this section and its charts are open to subscribers. The first 14 days are free.",
    gated_btn: "Subscribe to read in full →",
    cta_default_headline: "We've already mapped entries on the tickers in this report.",
    cta_default_body: "Levels, stops, and targets live inside the members area and Telegram, pushed the moment a setup triggers. Start a 14-day trial and get access before we open the first position in this theme. No card required.",
    cta_kicker: "// From analysis to positions",
    cta_start_trial: "Start 14-day trial →",
    cta_notify_email: "Just notify me by email",
    sticky_body: "We've already mapped entries on the tickers in this report.",
    sticky_link: "Start 14-day trial →", sticky_close: "Dismiss",
    final_kicker: "// Two ways to stay in the loop",
    final_title: "You've read the thesis. Here's how to trade it.",
    final_lead: "The Belfed members area publishes entries, stops and targets on this theme the moment they trigger, in Telegram and on the dashboard. Every closed trade is then logged permanently on our public track record.",
    track_ytd_label: "YTD 2026 · 87 trades · win rate ~62%",
    track_2025_label: "2025 · 61 trades",
    track_all_label: "Every trade logged publicly",
    path_1_label: "Option 1 · Full access",
    path_1_title: "Start a 14-day trial",
    path_1_body: "Full members area, Telegram alerts, request analysis on any asset. No card required. Cancel with one tap.",
    path_1_cta: "Start 14-day trial →",
    path_2_label: "Option 2 · Just the alerts",
    path_2_title: "Get notified when we open the first position",
    path_2_body: "One short email when we act on this theme. Unsubscribe in one click.",
    lead_email_placeholder: "you@example.com",
    lead_consent: "I agree to receive Belfed research updates and alerts on this theme by email. One short email at a time, unsubscribe in one click.",
    lead_submit: "Notify me →",
    lead_ok: "Got it. We'll email you when we act on this theme.",
    lead_err: "Something went wrong. Please try again in a minute.",
    lead_no_consent: "Please tick the consent box to continue.",
    disclaimer_label: "Disclaimer.",
    disclaimer_body: 'This report is independent market research produced by Belfed Analytics for informational and educational purposes only. It is not investment advice, an offer, or a solicitation to buy or sell any security, digital asset, or derivative, and it does not take into account the reader\'s objectives, financial situation, or needs. Views expressed reflect our analysis on the publication date and may change without notice. Any decision to act on this material is the reader\'s sole responsibility. Trading and investing carry risk of loss, including total loss of capital. See our full <a href="/disclaimer.html">disclaimer</a> and <a href="/privacy.html">privacy policy</a>.',
    footer_copyright: "© 2025–2026 Belfed Analytics. All rights reserved.",
    footer_research: "Research", footer_disclaimer: "Disclaimer",
    footer_privacy: "Privacy", footer_terms: "Terms",
    footer_alt_site: "RU site", footer_note: "Not financial advice.",
    card_reading: "min", author_name: "Belfed Analytics",
  },
} as const;

const MONTHS_RU = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
const MONTHS_EN = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function formatDateRu(iso: string): string { const d = new Date(iso); return `${d.getDate()} ${MONTHS_RU[d.getMonth()]} ${d.getFullYear()}`; }
function formatDateEn(iso: string): string { const d = new Date(iso); return `${MONTHS_EN[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; }

function esc(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function attr(s: string | null | undefined): string { return esc(s); }

function renderBody(text: string | null | undefined): string {
  if (!text) return "";
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  return paragraphs.map(p => {
    let out = esc(p).replace(/\n/g, "<br>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
    return `<p>${out}</p>`;
  }).join("\n");
}

function slugSuffix(slug: string): string { return slug.replace(/-/g, "_"); }
function domain(lang: Lang): string { return lang === "ru" ? "belfed.ru" : "belfed.com"; }
function altDomain(lang: Lang): string { return lang === "ru" ? "belfed.com" : "belfed.ru"; }

function reportTitle(r: ReportRow, lang: Lang): string {
  const t = lang === "ru" ? r.title_ru : r.title_en;
  return t || r.title_en || r.title_ru || r.slug;
}
function reportSubtitle(r: ReportRow, lang: Lang): string {
  const s = lang === "ru" ? r.subtitle_ru : r.subtitle_en;
  return s || "";
}
function ctaHeadline(r: ReportRow, lang: Lang, t: typeof T.ru): string {
  const custom = lang === "ru" ? r.cta_headline_ru : r.cta_headline_en;
  return custom || t.cta_default_headline;
}
function ctaBody(r: ReportRow, lang: Lang, t: typeof T.ru): string {
  const custom = lang === "ru" ? r.cta_body_ru : r.cta_body_en;
  return custom || t.cta_default_body;
}

function altPair(path: string): string {
  // Same path lives on both domains; RU on belfed.ru, EN on belfed.com.
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

function headBase(lang: Lang, opts: { title: string; description: string; canonical: string; ogTitle: string; ogDescription: string; ogImage: string; ogType?: "website" | "article"; altPath?: string; jsonLd?: unknown[]; robots?: string; }): string {
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="/logo-belfed-512.png">
  <title>${esc(opts.title)}</title>
  <link rel="canonical" href="${attr(opts.canonical)}" />
  <meta name="description" content="${attr(opts.description)}" />
  <meta property="og:type" content="${opts.ogType || "website"}" />
  <meta property="og:site_name" content="${lang === "ru" ? "BelFed" : "Belfed"}" />
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
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Courier+Prime:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">
${opts.robots ? `  <meta name="robots" content="${attr(opts.robots)}" />` : ""}
${opts.altPath ? altPair(opts.altPath) : ""}
${(opts.jsonLd || []).map(jsonLdBlock).join("\n")}`;
}

const ORG_ID = "https://belfed.com/#organization";

function orgNode(lang: Lang) {
  return {
    "@type": "Organization",
    "@id": ORG_ID,
    name: lang === "ru" ? "BelFed Analytics" : "Belfed Analytics",
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

function sharedStyles(): string {
  return `<style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root { --black:#0a0a0a; --white:#f5f5f0; --paper:#efefe7; --gray:#66665f; --gray-soft:#888; --border:#d0d0ca; --green:#1a6b3a; --green-soft:#1a6b3a14; --red:#8b1a1a; --font:'Courier Prime','Courier New',monospace; }
    html { scroll-behavior: smooth; scroll-padding-top: 72px; }
    body { font-family: var(--font); background: var(--white); color: var(--black); font-size: 15px; line-height: 1.6; -webkit-font-smoothing: antialiased; }
    nav { position: fixed; top:0; left:0; right:0; z-index:100; background: var(--white); border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; padding:0 40px; height:56px; }
    .nav-logo { font-size:17px; font-weight:700; letter-spacing:0.05em; text-decoration:none; color: var(--black); }
    .nav-links { display:flex; gap:32px; list-style:none; }
    .nav-links a { font-size:11px; letter-spacing:0.12em; text-transform:uppercase; text-decoration:none; color: var(--black); transition: opacity 0.2s; }
    .nav-links a:hover { opacity: 0.5; }
    .nav-links a.current { border-bottom: 1px solid var(--black); padding-bottom: 2px; }
    .nav-cta { font-size:11px; letter-spacing:0.12em; text-transform:uppercase; text-decoration:none; color: var(--white); background: var(--black); padding: 10px 20px; border:1px solid var(--black); transition: background 0.2s, color 0.2s; }
    .nav-cta:hover { background: transparent; color: var(--black); }
    main { padding-top: 56px; }
    footer { border-top: 1px solid var(--border); padding: 24px 40px; display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--gray); flex-wrap: wrap; gap: 12px; }
    footer a { color: var(--gray); text-decoration: none; }
    footer a:hover { color: var(--black); }
    .footer-links { display: flex; gap: 20px; flex-wrap: wrap; }
    .skip-link{position:absolute;left:-9999px;top:0;z-index:1000;background:var(--black);color:var(--white);padding:10px 16px;border-radius:0 0 6px 0;font-weight:700;text-decoration:none}
    .skip-link:focus{left:0}
    @media (max-width: 700px) { nav { padding: 0 20px; } .nav-links { display: none; } footer { padding: 20px; } }
  </style>`;
}

function reportPageStyles(): string {
  return `<style>
    .sticky-banner { position: fixed; top: 56px; left: 0; right: 0; z-index: 99; background: var(--black); color: var(--white); padding: 10px 40px; font-size: 12px; letter-spacing: 0.05em; display: flex; align-items: center; justify-content: center; gap: 20px; flex-wrap: wrap; transform: translateY(-100%); transition: transform 0.3s ease-out; }
    .sticky-banner.show { transform: translateY(0); }
    .sticky-banner a { color: var(--white); text-decoration: underline; text-underline-offset: 3px; font-weight: 700; }
    .sticky-banner button.close { background: transparent; border: 1px solid rgba(255,255,255,0.4); color: var(--white); padding: 4px 10px; cursor: pointer; font: inherit; font-size: 11px; }
    .hero { max-width: 820px; margin: 0 auto; padding: 80px 40px 40px; }
    .hero .kicker { font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--gray); margin-bottom: 24px; }
    .hero h1 { font-size: clamp(30px, 4.4vw, 52px); font-weight: 700; line-height: 1.12; letter-spacing: -0.01em; margin-bottom: 24px; text-wrap: balance; }
    .hero .subhead { font-size: 18px; color: #333; line-height: 1.6; margin-bottom: 32px; text-wrap: pretty; }
    .hero .meta { display: flex; gap: 24px; flex-wrap: wrap; font-size: 12px; color: var(--gray); text-transform: uppercase; letter-spacing: 0.1em; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); padding: 16px 0; }
    .hero .meta span strong { color: var(--black); font-weight: 700; }
    .hero .hero-cover { margin: 32px 0 0; border: 1px solid var(--border); background: var(--paper); aspect-ratio: 16 / 9; overflow: hidden; }
    .hero .hero-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .report { max-width: 720px; margin: 0 auto; padding: 40px 40px 80px; }
    .report h2 { font-size: 24px; font-weight: 700; margin: 56px 0 16px; letter-spacing: -0.01em; }
    .report h3 { font-size: 17px; font-weight: 700; margin: 32px 0 12px; }
    .report p { font-size: 15px; line-height: 1.8; color: #222; margin-bottom: 16px; text-wrap: pretty; }
    .report ul, .report ol { margin: 16px 0 20px 20px; }
    .report li { font-size: 15px; line-height: 1.8; color: #222; margin-bottom: 6px; }
    .report figure { margin: 32px 0; }
    .report figure img { width: 100%; border: 1px solid var(--border); }
    .report figcaption { font-size: 12px; color: var(--gray); text-align: center; margin-top: 8px; letter-spacing: 0.05em; }
    .report .callout { border: 1px solid var(--border); background: var(--paper); padding: 20px 24px; margin: 32px 0; }
    .report .callout .label { font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--gray); margin-bottom: 8px; }
    .gated { border: 1px dashed var(--gray-soft); background: var(--paper); padding: 24px 28px; margin: 32px 0; text-align: left; }
    .gated .gated-label { font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--green); margin-bottom: 12px; font-weight: 700; }
    .gated h3 { font-size: 18px; font-weight: 700; margin-bottom: 12px; line-height: 1.3; }
    .gated p { font-size: 14px; color: #444; margin-bottom: 16px; line-height: 1.6; }
    .gated a.btn { display: inline-block; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; text-decoration: none; padding: 12px 20px; border: 1px solid var(--black); background: var(--black); color: var(--white); }
    .gated a.btn:hover { background: transparent; color: var(--black); }
    .locked-preview { position: relative; margin: 8px 0 0; user-select: none; -webkit-user-select: none; }
    .locked-text { font-size: 16px; line-height: 1.75; color: #222; margin: 0; max-height: 9.5em; overflow: hidden; -webkit-mask-image: linear-gradient(to bottom, #000 35%, transparent 100%); mask-image: linear-gradient(to bottom, #000 35%, transparent 100%); }
    .locked-figs { display: grid; grid-template-columns: 1fr; gap: 12px; margin-top: 12px; -webkit-mask-image: linear-gradient(to bottom, #000 60%, transparent 100%); mask-image: linear-gradient(to bottom, #000 60%, transparent 100%); }
    .locked-figs.two { grid-template-columns: 1fr 1fr; }
    .locked-fig { aspect-ratio: 16 / 10; overflow: hidden; border: 1px solid var(--border); background: var(--paper); }
    .locked-fig img { width: 100%; height: 100%; object-fit: cover; display: block; filter: blur(5px) saturate(0.9); transform: scale(1.08); }
    .gated.over { position: relative; margin-top: -28px; background: var(--white); border: 1px solid var(--black); box-shadow: 0 -24px 40px 8px var(--white); }
    @media (max-width: 600px) { .locked-figs.two { grid-template-columns: 1fr; } .locked-figs.two .locked-fig + .locked-fig { display: none; } .gated.over { padding: 20px; } }
    .cta-inline { margin: 56px 0; border: 1px solid var(--black); padding: 32px 28px; background: var(--white); }
    .cta-inline .cta-kicker { font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--gray); margin-bottom: 12px; }
    .cta-inline h3 { font-size: 22px; font-weight: 700; line-height: 1.3; margin-bottom: 12px; letter-spacing: -0.01em; }
    .cta-inline p { font-size: 14px; color: #333; margin-bottom: 20px; line-height: 1.7; }
    .cta-inline .cta-row { display: flex; gap: 12px; flex-wrap: wrap; }
    .cta-inline .btn-primary, .cta-inline .btn-secondary { display: inline-block; padding: 14px 22px; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; text-decoration: none; border: 1px solid var(--black); transition: background 0.2s, color 0.2s; }
    .cta-inline .btn-primary { background: var(--black); color: var(--white); }
    .cta-inline .btn-primary:hover { background: transparent; color: var(--black); }
    .cta-inline .btn-secondary { background: transparent; color: var(--black); }
    .cta-inline .btn-secondary:hover { background: var(--black); color: var(--white); }
    .cta-final { max-width: 720px; margin: 40px auto 0; padding: 60px 40px; background: var(--paper); border-top: 1px solid var(--border); }
    .cta-final .kicker { font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--gray); margin-bottom: 16px; }
    .cta-final h2 { font-size: 28px; font-weight: 700; letter-spacing: -0.01em; margin-bottom: 16px; line-height: 1.2; }
    .cta-final p.lead { font-size: 15px; color: #333; margin-bottom: 28px; line-height: 1.7; }
    .cta-final .track { display: flex; gap: 24px; flex-wrap: wrap; font-size: 12px; color: var(--gray); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 32px; padding-bottom: 24px; border-bottom: 1px solid var(--border); }
    .cta-final .track strong { color: var(--black); font-weight: 700; display: block; font-size: 14px; margin-bottom: 4px; letter-spacing: 0.05em; }
    .cta-final .paths { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 24px; }
    .cta-final .path { border: 1px solid var(--border); padding: 24px 22px; background: var(--white); display: flex; flex-direction: column; }
    .cta-final .path .path-label { font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--gray); margin-bottom: 10px; }
    .cta-final .path h3 { font-size: 17px; font-weight: 700; margin-bottom: 8px; line-height: 1.3; }
    .cta-final .path p { font-size: 13px; color: #333; line-height: 1.7; margin-bottom: 16px; flex: 1; }
    .cta-final .path .btn { display: inline-block; text-align: center; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; text-decoration: none; padding: 14px 20px; border: 1px solid var(--black); }
    .cta-final .path .btn-primary { background: var(--black); color: var(--white); }
    .cta-final .path .btn-primary:hover { background: transparent; color: var(--black); }
    .lead-form { display: flex; flex-direction: column; gap: 10px; }
    .lead-form input[type="email"] { width: 100%; padding: 12px 14px; border: 1px solid var(--border); background: var(--white); font: inherit; font-size: 14px; }
    .lead-form input[type="email"]:focus { outline: 2px solid var(--green); outline-offset: 1px; }
    .lead-form .consent { display: flex; gap: 10px; align-items: flex-start; font-size: 12px; color: #444; line-height: 1.5; }
    .lead-form .consent input { margin-top: 3px; flex-shrink: 0; }
    .lead-form button { background: var(--black); color: var(--white); border: 1px solid var(--black); padding: 12px 20px; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; cursor: pointer; }
    .lead-form button:disabled { opacity: 0.5; cursor: not-allowed; }
    .lead-form .form-msg { font-size: 12px; padding: 10px 12px; display: none; }
    .lead-form .form-msg.show { display: block; }
    .lead-form .form-msg.ok { background: var(--green-soft); color: var(--green); border: 1px solid var(--green); }
    .lead-form .form-msg.err { background: #f5e3e3; color: var(--red); border: 1px solid var(--red); }
    .lead-form .honeypot { position: absolute; left: -9999px; opacity: 0; }
    .disclaimer-box { max-width: 720px; margin: 40px auto 40px; padding: 24px 32px; border: 1px solid var(--border); background: var(--paper); font-size: 12px; color: #444; line-height: 1.7; }
    .disclaimer-box strong { color: var(--black); }
    @media (max-width: 700px) { .sticky-banner { padding: 10px 20px; font-size: 11px; top: 56px; } .hero { padding: 40px 20px 30px; } .report { padding: 20px 20px 60px; } .cta-final { padding: 40px 20px; } .cta-final .paths { grid-template-columns: 1fr; } }
  </style>`;
}

function indexPageStyles(): string {
  return `<style>
    .index-hero { max-width: 960px; margin: 0 auto; padding: 80px 40px 40px; }
    .index-hero .kicker { font-size: 11px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--gray); margin-bottom: 24px; }
    .index-hero h1 { font-size: clamp(36px, 5vw, 64px); font-weight: 700; line-height: 1.05; letter-spacing: -0.02em; margin-bottom: 24px; }
    .index-hero p.lead { font-size: 17px; color: #333; line-height: 1.6; max-width: 640px; }
    .cards { max-width: 960px; margin: 40px auto 100px; padding: 0 40px; display: grid; grid-template-columns: 1fr; gap: 0; border-top: 1px solid var(--border); }
    .card { display: block; text-decoration: none; color: inherit; padding: 32px 0; border-bottom: 1px solid var(--border); transition: background 0.15s; }
    .card:hover { background: var(--paper); padding-left: 12px; padding-right: 12px; margin-left: -12px; margin-right: -12px; }
    .card .card-meta { display: flex; gap: 16px; flex-wrap: wrap; font-size: 11px; color: var(--gray); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 12px; }
    .card .card-meta .tag { border: 1px solid var(--border); padding: 3px 8px; }
    .card h2 { font-size: clamp(22px, 3vw, 30px); font-weight: 700; line-height: 1.2; letter-spacing: -0.01em; margin-bottom: 12px; text-wrap: balance; }
    .card p.card-sub { font-size: 15px; color: #444; line-height: 1.6; max-width: 640px; }
    .card .card-arrow { font-size: 12px; color: var(--gray); text-transform: uppercase; letter-spacing: 0.15em; margin-top: 16px; }
    .card:hover .card-arrow { color: var(--black); }
    .card.has-cover { display: grid; grid-template-columns: 300px 1fr; gap: 32px; align-items: start; }
    .card .card-cover { aspect-ratio: 16 / 9; overflow: hidden; border: 1px solid var(--border); background: var(--paper); }
    .card .card-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
    @media (max-width: 760px) { .card.has-cover { grid-template-columns: 1fr; gap: 16px; } }
    .card[hidden] { display: none !important; }
    .rs-bar { max-width: 960px; margin: 8px auto 0; padding: 0 40px; display: grid; grid-template-columns: 1fr 300px; gap: 16px 24px; align-items: center; }
    .rs-bar[hidden] { display: none; }
    .rs-chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .rs-chip { font: inherit; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--black); background: transparent; border: 1px solid var(--border); padding: 7px 12px; cursor: pointer; transition: border-color .15s, background .15s, color .15s; }
    .rs-chip:hover { border-color: var(--black); }
    .rs-chip .rs-n { color: var(--gray); margin-left: 4px; }
    .rs-chip.is-active { background: var(--black); color: var(--white); border-color: var(--black); }
    .rs-chip.is-active .rs-n { color: #bdbdb5; }
    .rs-chip:focus-visible, .rs-reset:focus-visible, .rs-clear:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }
    .rs-search { position: relative; display: flex; align-items: center; border-bottom: 1px solid var(--black); }
    .rs-search svg { color: var(--gray); flex-shrink: 0; }
    .rs-search input { flex: 1; min-width: 0; font: inherit; font-size: 14px; color: var(--black); background: transparent; border: 0; padding: 10px 28px 10px 10px; outline: none; -webkit-appearance: none; appearance: none; }
    .rs-search input::-webkit-search-cancel-button { display: none; }
    .rs-search input::placeholder { color: var(--gray-soft); }
    .rs-search:focus-within { border-bottom-color: var(--green); box-shadow: 0 1px 0 var(--green); }
    .rs-clear { position: absolute; right: 0; top: 50%; transform: translateY(-50%); width: 28px; height: 28px; font: inherit; font-size: 18px; line-height: 1; color: var(--gray); background: none; border: 0; cursor: pointer; }
    .rs-clear:hover { color: var(--black); }
    .rs-clear[hidden] { display: none; }
    .rs-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .rs-count { grid-column: 1 / -1; font-size: 11px; color: var(--gray); text-transform: uppercase; letter-spacing: 0.1em; }
    .rs-bar + .cards { margin-top: 16px; }
    .rs-empty { max-width: 960px; margin: -60px auto 100px; padding: 40px; text-align: center; color: var(--gray); }
    .rs-empty[hidden] { display: none; }
    .rs-empty p { margin-bottom: 16px; font-size: 15px; }
    .rs-reset { font: inherit; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; background: var(--black); color: var(--white); border: 1px solid var(--black); padding: 10px 18px; cursor: pointer; }
    @media (max-width: 860px) { .rs-bar { grid-template-columns: 1fr; } }
    @media (max-width: 700px) { .rs-bar { padding: 0 20px; } .rs-empty { padding: 20px; } }
    .empty { padding: 80px 40px; text-align: center; color: var(--gray); font-size: 14px; max-width: 720px; margin: 0 auto; }
    @media (max-width: 700px) { .index-hero { padding: 40px 20px 30px; } .cards { padding: 0 20px; margin-bottom: 60px; } .card:hover { padding-left: 0; padding-right: 0; margin-left: 0; margin-right: 0; } }
  </style>`;
}

function navBar(lang: Lang, t: typeof T.ru): string {
  const alt = altDomain(lang);
  return `<nav>
    <a href="/" class="nav-logo">BELFED_</a>
    <ul class="nav-links">
      <li><a href="/">${t.nav_home}</a></li>
      <li><a href="/trades.html">${t.nav_track}</a></li>
      <li><a href="/research/" class="current">${t.nav_research}</a></li>
      <li><a href="/products.html">${t.nav_products}</a></li>
      <li><a href="/about.html">${t.nav_about}</a></li>
      <li><a href="https://${alt}/research/" target="_blank" rel="noopener">${t.nav_lang}</a></li>
    </ul>
    <a href="https://t.me/belfedbot?start=research_${lang}" class="nav-cta">${t.nav_cta}</a>
  </nav>`;
}

function footerBar(lang: Lang, t: typeof T.ru): string {
  const alt = altDomain(lang);
  const terms = lang === "ru" ? "/oferta.html" : "/terms.html";
  return `<footer>
    <span>${t.footer_copyright}</span>
    <div class="footer-links">
      <a href="/research/">${t.footer_research}</a>
      <a href="/disclaimer.html">${t.footer_disclaimer}</a>
      <a href="/privacy.html">${t.footer_privacy}</a>
      <a href="${terms}">${t.footer_terms}</a>
      <a href="https://${alt}" target="_blank" rel="noopener">${t.footer_alt_site}</a>
      <span>${t.footer_note}</span>
    </div>
  </footer>`;
}

// Covers come from our own Supabase storage. Anything else is ignored so a bad
// value in the DB can never inject markup or pull third-party images.
function safeImg(u: string | null | undefined): string | null {
  if (!u) return null;
  return /^https:\/\/obujqvqqmyfcfflhqvud\.supabase\.co\/storage\/v1\/object\/public\/[A-Za-z0-9._\/-]+\.(png|jpe?g|webp)$/i.test(u) ? u : null;
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
  return [reportTitle(r, lang), reportSubtitle(r, lang), dateStr, ...(r.asset_classes || []), ...(r.sectors || []), ...(r.tags || []), ...classes.map(c => t.cls[c] || c)]
    .filter(Boolean).join(" ").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
}

// The static /research/ index can lag behind publishing (GitHub cron runs every few
// hours). On load, compare it with research-list; if a newer public report exists,
// swap in a fresh render from this function. One attempt per set of missing slugs.
function freshScript(lang: Lang): string {
  return `<script>
(function(){
  try{
    var F=${JSON.stringify(SUPABASE_URL + "/functions/v1/")}, L=${JSON.stringify(lang)};
    var have={}; [].forEach.call(document.querySelectorAll('a.card'),function(a){have[a.getAttribute('href')]=1;});
    fetch(F+'research-list?lang='+L,{cache:'no-store'}).then(function(r){return r.ok?r.json():null;}).then(function(j){
      var items=(j&&j.items)||[]; var miss=items.filter(function(it){return it&&it.slug&&!have['/research/'+it.slug+'/'];}).map(function(it){return it.slug;});
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

function renderCard(r: ReportRow, lang: Lang, t: typeof T.ru): string {
  const title = reportTitle(r, lang);
  const sub = reportSubtitle(r, lang);
  const date = r.report_date || r.published_at;
  const dateStr = date ? t.report_date_fmt(date) : "";
  const tags = (r.tags || []).slice(0, 3);
  const sectors = (r.sectors || []).slice(0, 2);
  const seen = new Set<string>();
  const chips = [...sectors, ...tags].filter(Boolean).filter(c => { const k = String(c).trim().toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 4);
  const cover = safeImg(r[`cover_image_url_${lang}`] || r.cover_image_url);
  const classes = reportClasses(r);
  return `<a href="/research/${esc(r.slug)}/" class="card${cover ? " has-cover" : ""}" data-classes="${attr(classes.join(" "))}" data-search="${attr(searchText(r, lang, dateStr, classes))}">
    ${cover ? `<div class="card-cover"><img src="${attr(cover)}" alt="" loading="lazy" decoding="async" width="1672" height="941" /></div>` : ""}
    <div class="card-body">
    <div class="card-meta">
      ${dateStr ? `<span>${esc(dateStr)}</span>` : ""}
      ${chips.map(c => `<span class="tag">${esc(c)}</span>`).join("")}
    </div>
    <h2>${esc(title)}</h2>
    ${sub ? `<p class="card-sub">${esc(sub)}</p>` : ""}
    <div class="card-arrow">${lang === "ru" ? "Читать →" : "Read →"}</div>
    </div>
  </a>`;
}

function renderIndex(lang: Lang, reports: ReportRow[]): string {
  const t = T[lang];
  const dom = domain(lang);
  const canonical = `https://${dom}/research/`;
  const ogImage = `https://${dom}/og-belfed.png`;
  const head = headBase(lang, {
    title: t.index_meta_title, description: t.index_meta_desc, canonical,
    ogTitle: t.index_meta_title, ogDescription: t.index_meta_desc, ogImage, ogType: "website",
    altPath: "/research/",
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
        isPartOf: { "@type": "WebSite", url: `https://${dom}/`, name: lang === "ru" ? "BelFed" : "Belfed" },
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
  const counts: Record<string, number> = {};
  for (const r of reports) for (const c of reportClasses(r)) counts[c] = (counts[c] || 0) + 1;
  const chipBtn = (key: string, label: string, n: number, active: boolean) =>
    `<button type="button" class="rs-chip${active ? " is-active" : ""}" data-class="${key}" aria-pressed="${active}">${esc(label)} <span class="rs-n">${n}</span></button>`;
  const filters = reports.length < 2 ? "" : `<div class="rs-bar" id="rsBar" hidden>
      <div class="rs-chips" role="group" aria-label="${attr(t.f_group)}">
        ${chipBtn("", t.f_all, reports.length, true)}
        ${CLASS_ORDER.filter(c => counts[c]).map(c => chipBtn(c, t.cls[c], counts[c], false)).join("\n        ")}
      </div>
      <div class="rs-search" role="search">
        <label for="rsQ" class="rs-sr">${esc(t.f_search_label)}</label>
        <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <input type="search" id="rsQ" placeholder="${attr(t.f_search_ph)}" autocomplete="off" spellcheck="false" enterkeyhint="search">
        <button type="button" class="rs-clear" id="rsClear" aria-label="${attr(t.f_clear)}" hidden>×</button>
      </div>
      <div class="rs-count" id="rsCount" aria-live="polite">${esc(t.f_count(reports.length, reports.length))}</div>
    </div>`;
  const filterScript = !filters ? "" : `<script>
(function(){
  var bar=document.getElementById('rsBar'); if(!bar) return; bar.hidden=false;
  var cards=[].slice.call(document.querySelectorAll('.cards .card'));
  var chips=[].slice.call(bar.querySelectorAll('.rs-chip'));
  var q=document.getElementById('rsQ'), clr=document.getElementById('rsClear'), cnt=document.getElementById('rsCount'), empty=document.getElementById('rsEmpty');
  var fmt=${lang === "ru" ? "function(n,t){return n===t?'Отчётов: '+t:'Найдено: '+n+' из '+t;}" : "function(n,t){return n===t?t+' reports':n+' of '+t+' reports';}"};
  var cls='';
  function norm(s){return (s||'').toLowerCase().replace(/ё/g,'е').trim();}
  function apply(push){
    var terms=norm(q.value).split(/\\s+/).filter(Boolean), shown=0;
    cards.forEach(function(c){
      var okC=!cls||(' '+c.getAttribute('data-classes')+' ').indexOf(' '+cls+' ')>-1;
      var hay=c.getAttribute('data-search')||'';
      var okQ=terms.every(function(w){return hay.indexOf(w)>-1;});
      var ok=okC&&okQ; c.hidden=!ok; if(ok) shown++;
    });
    chips.forEach(function(b){var a=b.getAttribute('data-class')===cls; b.classList.toggle('is-active',a); b.setAttribute('aria-pressed',a);});
    clr.hidden=!q.value; cnt.textContent=fmt(shown,cards.length); empty.hidden=shown>0;
    if(push){try{var u=new URL(location.href); cls?u.searchParams.set('class',cls):u.searchParams.delete('class'); q.value.trim()?u.searchParams.set('q',q.value.trim()):u.searchParams.delete('q'); history.replaceState(null,'',u.pathname+u.search+u.hash);}catch(e){}}
  }
  chips.forEach(function(b){b.addEventListener('click',function(){var k=b.getAttribute('data-class'); cls=(cls===k&&k)?'':k; apply(true);});});
  var tm; q.addEventListener('input',function(){clearTimeout(tm); tm=setTimeout(function(){apply(true);},120);});
  q.addEventListener('keydown',function(e){if(e.key==='Escape'&&q.value){q.value='';apply(true);}});
  clr.addEventListener('click',function(){q.value='';apply(true);q.focus();});
  document.getElementById('rsReset').addEventListener('click',function(){q.value='';cls='';apply(true);});
  try{var p=new URLSearchParams(location.search); var pc=p.get('class')||''; if(chips.some(function(b){return b.getAttribute('data-class')===pc;})) cls=pc; q.value=p.get('q')||'';}catch(e){}
  apply(false);
})();
</script>`;
  const cards = reports.length === 0
    ? `<div class="empty">${t.index_empty}</div>`
    : `${filters}<section class="cards">${reports.map(r => renderCard(r, lang, t)).join("\n")}</section>
    <div class="rs-empty" id="rsEmpty" hidden><p>${esc(t.f_none)}</p><button type="button" id="rsReset" class="rs-reset">${esc(t.f_reset)}</button></div>`;
  return `${head}
${sharedStyles()}
${indexPageStyles()}
</head>
<body>
  <a class="skip-link" href="#main-content">${t.skip}</a>
  ${navBar(lang, t)}
  <main id="main-content">
    <section class="index-hero">
      <div class="kicker">${t.index_kicker}</div>
      <h1>${t.index_title}</h1>
      <p class="lead">${esc(t.index_subtitle)}</p>
    </section>
    ${cards}
  </main>
  ${footerBar(lang, t)}
  ${filterScript}
  ${freshScript(lang)}
  <script src="/belfed-analytics.js"></script>
</body>
</html>`;
}

function renderSection(s: SectionRow, lang: Lang, t: typeof T.ru, startPayload: string): string {
  const label = lang === "ru" ? s.section_label_ru : s.section_label_en;
  const num = String(s.position).padStart(2, "0");
  const heading = label && /^\s*\d+\s*$/.test(label) ? label.trim().padStart(2, "0") : (label ? `${num} · ${label}` : num);
  if (s.is_public === false) {
    const gh = lang === "ru" ? s.headline_ru : s.headline_en;
    const tx = lang === "ru" ? s.teaser_ru : s.teaser_en;
    const imgs = (s.teaser_imgs || []).slice(0, 2);
    const preview = (tx || imgs.length) ? `<div class="locked-preview">
      ${tx ? `<p class="locked-text">${esc(tx)}</p>` : ""}
      ${imgs.length ? `<div class="locked-figs${imgs.length > 1 ? " two" : ""}" aria-hidden="true">${imgs.map(u => `<div class="locked-fig"><img src="${attr(u)}" alt="" loading="lazy" decoding="async"></div>`).join("")}</div>` : ""}
    </div>` : "";
    return `<section class="sec-locked"><h2>${esc(heading)}</h2>${gh && gh !== label ? `<h3>${esc(gh)}</h3>` : ""}${preview}<div class="gated${preview ? " over" : ""}"><div class="gated-label">${t.gated_label}</div>${preview ? "" : `<h3>${esc(label || (lang === "ru" ? "Секция" : "Section"))}</h3>`}<p>${esc(t.gated_body)}</p><a href="https://t.me/belfedbot?start=${startPayload}_gated" class="btn">${t.gated_btn}</a></div></section>`;
  }
  const headline = lang === "ru" ? s.headline_ru : s.headline_en;
  const body = lang === "ru" ? s.body_ru : s.body_en;
  let chartsHtml = "";
  if (Array.isArray(s.chart_images) && s.chart_images.length > 0) {
    chartsHtml = s.chart_images.map(c => {
      const cap = lang === "ru" ? c.caption_ru : c.caption_en;
      const src = lang === "en" && c.url_en ? c.url_en : c.url;
      return `<figure><img src="${attr(src)}" alt="${attr(cap || (headline || label || ""))}">${cap ? `<figcaption>${esc(cap)}</figcaption>` : ""}</figure>`;
    }).join("\n");
  } else if (s.chart_image_url) {
    const cap = lang === "ru" ? s.chart_caption_ru : s.chart_caption_en;
    chartsHtml = `<figure><img src="${attr(s.chart_image_url)}" alt="${attr(cap || (headline || label || ""))}">${cap ? `<figcaption>${esc(cap)}</figcaption>` : ""}</figure>`;
  }
  return `<section><h2>${esc(heading)}</h2>${headline && headline !== label ? `<h3>${esc(headline)}</h3>` : ""}${renderBody(body)}${chartsHtml}</section>`;
}

function renderReport(lang: Lang, r: ReportRow, sections: SectionRow[]): string {
  const t = T[lang];
  const dom = domain(lang);
  const alt = altDomain(lang);
  const title = reportTitle(r, lang);
  const sub = reportSubtitle(r, lang);
  const canonical = `https://${dom}/research/${r.slug}/`;
  const altUrl = `https://${alt}/research/${r.slug}/`;
  const heroCover = safeImg(r[`cover_image_url_${lang}`] || r.cover_image_url);
  const ogImage = heroCover || `https://${dom}/og-belfed.png`;
  const dateISO = r.report_date || r.published_at;
  const dateStr = dateISO ? t.report_date_fmt(dateISO) : "";
  const coverage = [...new Map([...(r.asset_classes || []), ...(r.sectors || [])].filter(Boolean).map(c => [String(c).trim().toLowerCase(), c])).values()].join(" · ");
  const slugAd = slugSuffix(r.slug);
  const startPayload = `research_${slugAd}_${lang}`;
  const metaTitle = `${title}${lang === "ru" ? " | Исследование BelFed" : " | Belfed Research"}`;
  const metaDesc = sub || title;
  const head = headBase(lang, {
    title: metaTitle, description: metaDesc, canonical,
    ogTitle: title, ogDescription: sub || metaDesc, ogImage, ogType: "article",
    altPath: `/research/${r.slug}/`,
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
        keywords: [...(r.asset_classes || []), ...(r.sectors || []), ...(r.tags || [])].filter(Boolean).join(", ") || undefined,
        isAccessibleForFree: true,
      },
      {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: lang === "ru" ? "Главная" : "Home", item: `https://${dom}/` },
          { "@type": "ListItem", position: 2, name: lang === "ru" ? "Исследования" : "Research", item: `https://${dom}/research/` },
          { "@type": "ListItem", position: 3, name: title, item: canonical },
        ],
      },
    ],
  });
  const hasContent = (s: SectionRow) => {
    if (s.is_public === false) return true;
    const h = lang === "ru" ? s.headline_ru : s.headline_en;
    const b = lang === "ru" ? s.body_ru : s.body_en;
    const imgs = Array.isArray(s.chart_images) && s.chart_images.length > 0;
    return Boolean((h && String(h).trim()) || (b && String(b).trim()) || imgs || s.chart_image_url);
  };
  const sectionsHtml = sections.filter(hasContent).map(s => renderSection(s, lang, t, startPayload)).join("\n");
  const leadTicker = (r.tags && r.tags[0]) ? r.tags[0].toUpperCase().replace(/[^A-Z0-9]/g, "_") : slugAd.toUpperCase();
  const leadNote = `research_${slugAd}`;
  const leadSource = `research_${slugAd}`;

  return `${head}
${sharedStyles()}
${reportPageStyles()}
</head>
<body>
  <a class="skip-link" href="#main-content">${t.skip}</a>
  <nav>
    <a href="/" class="nav-logo">BELFED_</a>
    <ul class="nav-links">
      <li><a href="/">${t.nav_home}</a></li>
      <li><a href="/trades.html">${t.nav_track}</a></li>
      <li><a href="/research/">${t.nav_research}</a></li>
      <li><a href="/products.html">${t.nav_products}</a></li>
      <li><a href="/about.html">${t.nav_about}</a></li>
      <li><a href="${altUrl}" target="_blank" rel="noopener">${t.nav_lang}</a></li>
    </ul>
    <a href="https://t.me/belfedbot?start=${startPayload}" class="nav-cta">${t.nav_cta}</a>
  </nav>
  <div class="sticky-banner" id="stickyBanner">
    <span>${esc(t.sticky_body)} <a href="https://t.me/belfedbot?start=${startPayload}_banner">${t.sticky_link}</a></span>
    <button class="close" id="stickyClose" aria-label="${attr(t.sticky_close)}">×</button>
  </div>
  <main id="main-content">
    <section class="hero">
      <div class="kicker">${t.report_kicker_prefix}${esc(dateStr)}</div>
      <h1>${esc(title)}</h1>
      ${sub ? `<p class="subhead">${esc(sub)}</p>` : ""}
      <div class="meta">
        <span><strong>${t.report_author}</strong> · ${esc(t.author_name)}</span>
        ${coverage ? `<span><strong>${t.report_coverage}</strong> · ${esc(coverage)}</span>` : ""}
      </div>
      ${heroCover ? `<figure class="hero-cover"><img src="${attr(heroCover)}" alt="${attr(title)}" width="1672" height="941" fetchpriority="high" decoding="async" /></figure>` : ""}
    </section>
    <article class="report">
${sectionsHtml}
      <div class="cta-inline">
        <div class="cta-kicker">${t.cta_kicker}</div>
        <h3>${esc(ctaHeadline(r, lang, t))}</h3>
        <p>${esc(ctaBody(r, lang, t))}</p>
        <div class="cta-row">
          <a href="https://t.me/belfedbot?start=${startPayload}_mid" class="btn-primary">${t.cta_start_trial}</a>
          <a href="#stay-in-loop" class="btn-secondary">${t.cta_notify_email}</a>
        </div>
      </div>
    </article>
    <section class="cta-final" id="stay-in-loop">
      <div class="kicker">${t.final_kicker}</div>
      <h2>${esc(t.final_title)}</h2>
      <p class="lead">${esc(t.final_lead)}</p>
      <div class="track">
        <div><strong>+93.54R</strong>${t.track_ytd_label}</div>
        <div><strong>+70.33R</strong>${t.track_2025_label}</div>
        <div><strong>${lang === "ru" ? "Каждая сделка" : "Every trade"}</strong>${lang === "ru" ? "публично" : "logged publicly"}</div>
      </div>
      <div class="paths">
        <div class="path">
          <div class="path-label">${t.path_1_label}</div>
          <h3>${t.path_1_title}</h3>
          <p>${esc(t.path_1_body)}</p>
          <a href="https://t.me/belfedbot?start=${startPayload}_final" class="btn btn-primary">${t.path_1_cta}</a>
        </div>
        <div class="path">
          <div class="path-label">${t.path_2_label}</div>
          <h3>${t.path_2_title}</h3>
          <p>${esc(t.path_2_body)}</p>
          <form class="lead-form" id="leadForm">
            <input type="email" id="leadEmail" placeholder="${attr(t.lead_email_placeholder)}" required autocomplete="email">
            <label class="consent">
              <input type="checkbox" id="leadConsent">
              <span>${esc(t.lead_consent)}</span>
            </label>
            <div class="honeypot"><input type="text" id="leadHoneypot" tabindex="-1" autocomplete="off"></div>
            <button type="submit" id="leadSubmit">${t.lead_submit}</button>
            <div class="form-msg ok" id="leadOk">${esc(t.lead_ok)}</div>
            <div class="form-msg err" id="leadErr">${esc(t.lead_err)}</div>
          </form>
        </div>
      </div>
    </section>
    <div class="disclaimer-box">
      <strong>${t.disclaimer_label}</strong> ${t.disclaimer_body}
    </div>
  </main>
  ${footerBar(lang, t)}
  <script src="/belfed-analytics.js"></script>
  <script>
    (function () {
      var banner = document.getElementById('stickyBanner');
      var close = document.getElementById('stickyClose');
      var dismissed = false;
      try { dismissed = sessionStorage.getItem('bf_research_banner_dismissed') === '1'; } catch (e) {}
      if (dismissed) return;
      window.addEventListener('scroll', function () {
        var h = document.documentElement;
        var scrolled = (h.scrollTop || document.body.scrollTop) / (h.scrollHeight - h.clientHeight);
        if (scrolled > 0.3) banner.classList.add('show');
      }, { passive: true });
      close.addEventListener('click', function () {
        banner.classList.remove('show');
        try { sessionStorage.setItem('bf_research_banner_dismissed', '1'); } catch (e) {}
      });
    })();
    (function () {
      var SUPA_URL = ${JSON.stringify(SUPABASE_URL)};
      var SUPA_KEY = ${JSON.stringify(SUPABASE_ANON_KEY)};
      var form = document.getElementById('leadForm');
      var okMsg = document.getElementById('leadOk');
      var errMsg = document.getElementById('leadErr');
      var LEAD_TICKER = ${JSON.stringify(leadTicker)};
      var LEAD_NOTE = ${JSON.stringify(leadNote)};
      var LEAD_SOURCE = ${JSON.stringify(leadSource)};
      var LEAD_LANG = ${JSON.stringify(lang)};
      var NO_CONSENT_MSG = ${JSON.stringify(t.lead_no_consent)};
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var btn = document.getElementById('leadSubmit');
        var email = (document.getElementById('leadEmail').value || '').trim().toLowerCase();
        var consent = document.getElementById('leadConsent').checked;
        var honeypot = document.getElementById('leadHoneypot').value || '';
        if (!email) return;
        if (!consent) { errMsg.textContent = NO_CONSENT_MSG; errMsg.classList.add('show'); return; }
        okMsg.classList.remove('show'); errMsg.classList.remove('show');
        var origLabel = btn.innerHTML;
        btn.disabled = true; btn.innerHTML = '…';
        var payload = { email: email, ticker: LEAD_TICKER, asset_class: null, timeframe: null, note: LEAD_NOTE, consent: consent, lang: LEAD_LANG, source: LEAD_SOURCE, website: honeypot };
        if (window.BelfedAnalytics) { var _utm = window.BelfedAnalytics.utmFields(); for (var k in _utm) if (_utm.hasOwnProperty(k)) payload[k] = _utm[k]; }
        fetch(SUPA_URL + '/functions/v1/landing-lead-create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY },
          body: JSON.stringify(payload)
        }).then(function (r) { return r.json().then(function (d) { return { status: r.status, body: d }; }); })
          .then(function (res) {
            btn.disabled = false; btn.innerHTML = origLabel;
            if (res.body && (res.body.ok || res.body.reason === 'dup')) {
              if (window.belfedTrack) window.belfedTrack('research_lead_submitted', { report: LEAD_NOTE });
              form.reset();
              okMsg.classList.add('show');
            } else {
              errMsg.classList.add('show');
            }
          })
          .catch(function () { btn.disabled = false; btn.innerHTML = origLabel; errMsg.classList.add('show'); });
      });
    })();
  </script>
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

function notFoundPage(lang: Lang): string {
  const t = T[lang];
  const dom = domain(lang);
  const head = headBase(lang, {
    title: (lang === "ru" ? "Отчёт не найден" : "Report not found") + " | " + t.author_name,
    description: t.index_meta_desc,
    canonical: `https://${dom}/research/`,
    ogTitle: (lang === "ru" ? "Отчёт не найден" : "Report not found"),
    ogDescription: t.index_meta_desc,
    ogImage: `https://${dom}/og-belfed.png`,
    robots: "noindex, follow",
  });
  return `${head}
${sharedStyles()}
<style>
  .nf { max-width: 720px; margin: 0 auto; padding: 100px 40px; text-align: center; }
  .nf h1 { font-size: clamp(28px, 4vw, 44px); font-weight: 700; margin-bottom: 24px; letter-spacing: -0.01em; }
  .nf p { font-size: 15px; color: #444; line-height: 1.6; margin-bottom: 24px; }
  .nf a { display: inline-block; background: var(--black); color: var(--white); padding: 14px 22px; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; text-decoration: none; border: 1px solid var(--black); }
</style>
</head>
<body>
  ${navBar(lang, t)}
  <main>
    <section class="nf">
      <h1>${lang === "ru" ? "Отчёт не найден" : "Report not found"}</h1>
      <p>${lang === "ru" ? "Возможно, отчёт был снят с публикации или ссылка устарела." : "The report may have been unpublished or the link is out of date."}</p>
      <a href="/research/">${lang === "ru" ? "К списку исследований →" : "Back to research →"}</a>
    </section>
  </main>
  ${footerBar(lang, t)}
</body>
</html>`;
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
      const { data: reports, error } = await supa
        .from("analytics_reports").select(CARD_COLUMNS)
        .eq("is_public", true).eq("status", "published")
        .order("report_date", { ascending: false })
        .order("published_at", { ascending: false, nullsFirst: false })
        .limit(50);
      if (error) return htmlResponse(`<h1>Server error</h1><pre>${esc(error.message)}</pre>`, 500, { "cache-control": "no-store" });
      return htmlResponse(renderIndex(lang, (reports || []) as ReportRow[]), 200);
    }
    const { data: reports, error: rErr } = await supa
      .from("analytics_reports").select(REPORT_COLUMNS)
      .eq("slug", slug).eq("is_public", true).eq("status", "published").limit(1);
    if (rErr) return htmlResponse(`<h1>Server error</h1><pre>${esc(rErr.message)}</pre>`, 500, { "cache-control": "no-store" });
    const report = (reports ?? [])[0] as ReportRow | undefined;
    if (!report) return htmlResponse(notFoundPage(lang), 404, { "cache-control": "public, max-age=60" });
    const { data: sections, error: sErr } = await supa
      .from("analytics_sections").select(SECTION_PUBLIC_COLUMNS)
      .eq("report_id", report.id).order("position", { ascending: true });
    if (sErr) return htmlResponse(`<h1>Server error</h1><pre>${esc(sErr.message)}</pre>`, 500, { "cache-control": "no-store" });
    const secs = (sections || []).map((s: Record<string, unknown>) => {
      if (s.is_public === false) {
        const ci = Array.isArray(s.chart_images) ? (s.chart_images as Array<{ url?: string; url_en?: string }>).map(c => c && (lang === "en" && c.url_en ? c.url_en : c.url)) : [];
        const urls = (ci.length ? ci : [s.chart_image_url as string | null]).map(u => teaserThumb(u as string | null)).filter(Boolean) as string[];
        return { id: s.id, position: s.position, is_conclusion: s.is_conclusion, is_public: false,
          section_label_ru: s.section_label_ru, section_label_en: s.section_label_en,
          headline_ru: s.headline_ru, headline_en: s.headline_en,
          teaser_ru: teaserText(s.body_ru as string), teaser_en: teaserText(s.body_en as string),
          teaser_imgs: urls } as SectionRow;
      }
      return s as unknown as SectionRow;
    });
    return htmlResponse(renderReport(lang, report, secs), 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return htmlResponse(`<h1>Server error</h1><pre>${esc(msg)}</pre>`, 500, { "cache-control": "no-store" });
  }
});

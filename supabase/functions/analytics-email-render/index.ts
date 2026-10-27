// analytics-email-render v3
// POST { report_id, language: 'ru'|'en', unsubscribe_token?: string }
// → { ok, html, subject, preheader }
//
// v3: added language switcher in footer (calls email-set-language).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const SITE_HOST = {
  ru: "https://belfed.ru",
  en: "https://belfed.com",
} as const;

const UNSUB_HOST = "https://obujqvqqmyfcfflhqvud.supabase.co/functions/v1/email-unsubscribe";
const SWITCH_HOST = "https://obujqvqqmyfcfflhqvud.supabase.co/functions/v1/email-set-language";

const HEADERS_TEXT = {
  daily:  { ru: "ДНЕВНАЯ АНАЛИТИКА",      en: "DAILY ANALYTICS" },
  weekly: { ru: "ЕЖЕНЕДЕЛЬНАЯ АНАЛИТИКА", en: "WEEKLY ANALYTICS" },
} as const;

const TAG_FALLBACKS = {
  ru: { daily: "ЕЖЕДНЕВНО", weekly: "ЕЖЕНЕДЕЛЬНО" },
  en: { daily: "DAILY",     weekly: "WEEKLY" },
} as const;

const TG_BOT_URL = "https://t.me/BelfedBot";

const I18N = {
  ru: {
    conclusion:        "// ГЛАВНЫЙ ВЫВОД",
    cta_label:         "// ЧИТАТЬ В БРАУЗЕРЕ + ОБСУЖДЕНИЕ В TELEGRAM",
    cta_button:        "ОТКРЫТЬ НА САЙТЕ →",
    cta_button_tg:     "TELEGRAM →",
    disclaimer_label:  "// DISCLAIMER",
    disclaimer_text:   "Материалы носят информационно-аналитический характер и не являются индивидуальной инвестиционной рекомендацией. BelFed не несёт ответственности за решения, принятые на основании этих данных. Прошлые результаты не гарантируют будущих.",
    footer_subscribed: "Вы получили это письмо, потому что подписаны на аналитику BelFed.",
    footer_settings:   "НАСТРОЙКИ EMAIL",
    footer_unsub:      "ОТПИСАТЬСЯ",
    footer_tg:         "TELEGRAM-БОТ",
    lang_switch_label: "ПОЛУЧАТЬ НА АНГЛИЙСКОМ",
    lang_switch_to:    "en",
    months: ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"],
  },
  en: {
    conclusion:        "// KEY TAKEAWAY",
    cta_label:         "// READ IN BROWSER + DISCUSS ON TELEGRAM",
    cta_button:        "OPEN ON SITE →",
    cta_button_tg:     "TELEGRAM →",
    disclaimer_label:  "// DISCLAIMER",
    disclaimer_text:   "This material is informational and analytical in nature and does not constitute individual investment advice. BelFed is not liable for decisions made based on this data. Past results do not guarantee future performance.",
    footer_subscribed: "You received this email because you are subscribed to BelFed Analytics.",
    footer_settings:   "EMAIL SETTINGS",
    footer_unsub:      "UNSUBSCRIBE",
    footer_tg:         "TELEGRAM BOT",
    lang_switch_label: "RECEIVE IN RUSSIAN",
    lang_switch_to:    "ru",
    months: ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],
  },
} as const;

function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function bodyToHtml(s: string): string {
  if (!s) return "";
  const escaped = escapeHtml(s);
  return escaped.replace(/\n\n+/g, "<br><br>").replace(/\n/g, "<br>");
}

function formatDate(dateStr: string, lang: "ru" | "en"): string {
  const d = new Date(dateStr + (dateStr.includes("T") ? "" : "T00:00:00Z"));
  if (isNaN(d.getTime())) return dateStr;
  const day = d.getUTCDate();
  const month = I18N[lang].months[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  if (lang === "ru") {
    return `// ${String(day).padStart(2, "0")} ${month.toUpperCase()} ${year}`;
  }
  return `// ${month.toUpperCase()} ${String(day).padStart(2, "0")}, ${year}`;
}

interface Section {
  position: number;
  is_conclusion: boolean;
  section_label: string;
  headline: string;
  body: string;
  charts: { url: string; caption: string }[];
}

interface Report {
  id: string;
  slug: string;
  report_date: string;
  report_type: "daily" | "weekly";
  title: string;
  subtitle: string;
  tags: string[];
  cover_image_url: string | null;
  sections: Section[];
}

function renderEmail(report: Report, lang: "ru" | "en", unsubToken: string): { html: string; subject: string; preheader: string } {
  const t = I18N[lang];
  const isDaily = report.report_type !== "weekly";
  const headerLine = HEADERS_TEXT[isDaily ? "daily" : "weekly"][lang];

  const dateLine = formatDate(report.report_date, lang);
  const ctaUrl = `${SITE_HOST[lang]}/analytics-view.html?slug=${encodeURIComponent(report.slug)}`;

  let tags = (report.tags || []).filter(Boolean);
  if (tags.length === 0) {
    tags = [TAG_FALLBACKS[lang][isDaily ? "daily" : "weekly"]];
  }
  const tagsHtml = tags
    .slice(0, 6)
    .map(tag => `<span style="display:inline-block;font-size:10px;letter-spacing:1px;padding:3px 9px;background:#fff;border:1px solid #000;text-transform:uppercase;margin-right:4px;margin-bottom:4px;font-family:'Courier New',Courier,monospace;">${escapeHtml(tag)}</span>`)
    .join("");

  const subtitleHtml = (report.subtitle || "")
    .split(/\n\n+/)
    .filter(p => p.trim())
    .map(p => `<div style="font-size:15px;line-height:1.65;margin-bottom:14px;color:#000;font-family:'Courier New',Courier,monospace;">${bodyToHtml(p)}</div>`)
    .join("");

  const coverHtml = report.cover_image_url
    ? `<tr><td style="padding:18px 28px 0 28px;">
         <img src="${escapeHtml(report.cover_image_url)}" alt="" width="544" style="width:100%;max-width:544px;height:auto;display:block;border:1px solid #000;">
       </td></tr>`
    : "";

  const normalSections = report.sections.filter(s => !s.is_conclusion).sort((a, b) => a.position - b.position);
  const conclusionSection = report.sections.find(s => s.is_conclusion);

  const sectionsHtml = normalSections.map((sec, idx) => {
    const num = String(idx + 1).padStart(2, "0");
    const label = sec.section_label && sec.section_label.trim() ? escapeHtml(sec.section_label) : num;

    const chartsHtml = (sec.charts || []).map(ch => `
      <tr><td style="padding:18px 28px 0 28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #000;background:#fff;">
          <tr><td>
            <img src="${escapeHtml(ch.url)}" alt="" width="544" style="width:100%;max-width:544px;height:auto;display:block;">
          </td></tr>
          ${ch.caption ? `<tr><td style="font-size:11px;padding:10px 14px;border-top:1px dashed #999;color:#666;letter-spacing:1px;font-style:italic;font-family:'Courier New',Courier,monospace;">${escapeHtml(ch.caption)}</td></tr>` : ""}
        </table>
      </td></tr>
    `).join("");

    return `
      <tr>
        <td style="padding:${idx === 0 ? "32px" : "42px"} 28px 0 28px;">
          <div style="font-size:10px;letter-spacing:3px;font-weight:bold;color:#999;margin-bottom:10px;text-transform:uppercase;font-family:'Courier New',Courier,monospace;">
            ${label}
          </div>
          <h2 style="font-size:20px;letter-spacing:1px;font-weight:bold;line-height:1.4;margin:0 0 16px 0;color:#000;font-family:'Courier New',Courier,monospace;">
            ${escapeHtml(sec.headline || "")}
          </h2>
          <div style="font-size:14px;line-height:1.75;color:#000;font-family:'Courier New',Courier,monospace;">
            ${bodyToHtml(sec.body || "")}
          </div>
        </td>
      </tr>
      ${chartsHtml}
    `;
  }).join("");

  const conclusionHtml = conclusionSection ? `
    <tr>
      <td style="padding:42px 28px 0 28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fff;border:1px solid #000;">
          <tr>
            <td style="padding:22px 24px;">
              <div style="font-size:10px;letter-spacing:3px;font-weight:bold;color:#000;margin-bottom:14px;text-transform:uppercase;font-family:'Courier New',Courier,monospace;">
                ${t.conclusion}
              </div>
              ${conclusionSection.headline ? `<h3 style="font-size:16px;letter-spacing:1px;font-weight:bold;line-height:1.4;margin:0 0 12px 0;color:#000;font-family:'Courier New',Courier,monospace;">${escapeHtml(conclusionSection.headline)}</h3>` : ""}
              <div style="font-size:14px;line-height:1.75;color:#000;font-family:'Courier New',Courier,monospace;">
                ${bodyToHtml(conclusionSection.body || "")}
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  ` : "";

  const tokenEnc = encodeURIComponent(unsubToken || "{{UNSUBSCRIBE_TOKEN}}");
  const unsubUrl = `${UNSUB_HOST}?token=${tokenEnc}`;
  const switchUrl = `${SWITCH_HOST}?token=${tokenEnc}&lang=${t.lang_switch_to}`;
  const settingsUrl = `${SITE_HOST[lang]}/account.html`;

  const subjectPrefix = lang === "ru" ? "[BelFed]" : "[BelFed Analytics]";
  const subject = `${subjectPrefix} ${report.title}`;
  const preheaderRaw = (report.subtitle || "").replace(/\s+/g, " ").trim().slice(0, 150);
  const preheader = preheaderRaw;

  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(subject)}</title>
<style>
  body { margin: 0; padding: 0; background: #ddd5c4; }
  table { border-collapse: collapse; }
  img { border: 0; outline: none; display: block; max-width: 100%; }
  a { color: inherit; }
  @media only screen and (max-width: 620px) {
    .belfed-content { width: 100% !important; }
    .belfed-pad { padding-left: 18px !important; padding-right: 18px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#ddd5c4;font-family:'Courier New',Courier,monospace;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ddd5c4;">${escapeHtml(preheader)}</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ddd5c4;padding:24px 12px;">
  <tr>
    <td align="center">
      <table role="presentation" width="600" class="belfed-content" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#f5f2eb;color:#000;">

        <tr>
          <td class="belfed-pad" style="padding:28px 28px 14px 28px;border-bottom:1px solid #000;text-align:center;">
            <div style="font-size:14px;letter-spacing:4px;font-weight:bold;margin-bottom:8px;font-family:'Courier New',Courier,monospace;">— BELFED_ —</div>
            <div style="font-size:18px;letter-spacing:3px;font-weight:bold;font-family:'Courier New',Courier,monospace;">— BELFED ANALYTICS —</div>
          </td>
        </tr>

        <tr>
          <td class="belfed-pad" style="padding:14px 28px 0 28px;text-align:center;">
            <div style="font-size:13px;letter-spacing:3px;color:#000;font-weight:bold;text-transform:uppercase;font-family:'Courier New',Courier,monospace;">${headerLine}</div>
          </td>
        </tr>

        <tr>
          <td class="belfed-pad" style="padding:14px 28px 0 28px;">
            <div style="font-size:11px;letter-spacing:2px;color:#555;text-transform:uppercase;font-family:'Courier New',Courier,monospace;">${escapeHtml(dateLine)}</div>
          </td>
        </tr>

        <tr>
          <td class="belfed-pad" style="padding:14px 28px 0 28px;">
            <h1 style="font-size:24px;letter-spacing:2px;font-weight:bold;line-height:1.3;margin:0 0 14px 0;text-transform:uppercase;font-family:'Courier New',Courier,monospace;color:#000;">
              ${escapeHtml(report.title)}
            </h1>
            ${subtitleHtml}
            <div style="margin-bottom:24px;margin-top:4px;">${tagsHtml}</div>
          </td>
        </tr>

        ${coverHtml}

        <tr><td class="belfed-pad" style="padding:0 28px;"><div style="border-top:1px dashed #999;"></div></td></tr>

        ${sectionsHtml}

        ${conclusionHtml}

        <tr>
          <td class="belfed-pad" style="padding:42px 28px 0 28px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px dashed #000;background:#fff;">
              <tr>
                <td align="center" style="padding:22px 18px;">
                  <div style="font-size:12px;letter-spacing:2px;color:#000;margin-bottom:16px;font-family:'Courier New',Courier,monospace;">
                    ${t.cta_label}
                  </div>
                  <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:10px 22px;background:#000;color:#f5f2eb;text-decoration:none;font-size:12px;letter-spacing:2px;font-family:'Courier New',Courier,monospace;font-weight:bold;margin:0 4px 8px 4px;">
                    ${t.cta_button}
                  </a>
                  <a href="${TG_BOT_URL}" style="display:inline-block;padding:10px 22px;background:#f5f2eb;color:#000;text-decoration:none;font-size:12px;letter-spacing:2px;font-family:'Courier New',Courier,monospace;font-weight:bold;border:1px solid #000;margin:0 4px 8px 4px;">
                    ${t.cta_button_tg}
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr>
          <td class="belfed-pad" style="padding:32px 28px 0 28px;">
            <div style="padding:18px 20px;border:1px dashed #999;background:#fff;font-size:11px;line-height:1.7;color:#444;font-family:'Courier New',Courier,monospace;">
              <b style="letter-spacing:2px;color:#000;">${t.disclaimer_label}</b><br>
              ${escapeHtml(t.disclaimer_text)}
            </div>
          </td>
        </tr>

        <tr>
          <td class="belfed-pad" style="padding:32px 28px 32px 28px;border-top:1px solid #000;">
            <div style="font-size:11px;letter-spacing:2px;color:#000;text-align:center;text-transform:uppercase;margin-bottom:14px;font-family:'Courier New',Courier,monospace;">— BELFED_ANALYTICS —</div>
            <div style="font-size:10px;line-height:1.7;color:#777;text-align:center;font-family:'Courier New',Courier,monospace;letter-spacing:1px;">
              ${escapeHtml(t.footer_subscribed)}<br>
              <a href="${escapeHtml(switchUrl)}" style="color:#000;text-decoration:underline;">${t.lang_switch_label}</a>
              <br><br>
              <a href="${escapeHtml(settingsUrl)}" style="color:#000;text-decoration:underline;">${t.footer_settings}</a>
              ·
              <a href="${TG_BOT_URL}" style="color:#000;text-decoration:underline;">${t.footer_tg}</a>
              ·
              <a href="${escapeHtml(unsubUrl)}" style="color:#000;text-decoration:underline;">${t.footer_unsub}</a>
              <br><br>
              © ${new Date().getUTCFullYear()} BelFed Analytics
            </div>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  return { html, subject, preheader };
}

async function fetchReport(supabase: ReturnType<typeof createClient>, reportId: string, lang: "ru" | "en"): Promise<Report | null> {
  const { data: r, error: e1 } = await supabase
    .from("analytics_reports")
    .select("id, slug, report_date, report_type, title_ru, title_en, subtitle_ru, subtitle_en, tags, cover_image_url, cover_image_url_ru, cover_image_url_en, status")
    .eq("id", reportId)
    .single();
  if (e1 || !r) return null;

  const { data: secs, error: e2 } = await supabase
    .from("analytics_sections")
    .select("position, is_conclusion, section_label_ru, section_label_en, headline_ru, headline_en, body_ru, body_en, chart_image_url, chart_caption_ru, chart_caption_en, chart_images")
    .eq("report_id", reportId)
    .order("position", { ascending: true });
  if (e2) return null;

  const sections: Section[] = (secs || []).map((s: any) => {
    const charts: { url: string; caption: string }[] = [];
    if (Array.isArray(s.chart_images) && s.chart_images.length > 0) {
      for (const c of s.chart_images) {
        if (c && c.url) {
          charts.push({
            url: c.url,
            caption: lang === "ru" ? (c.caption_ru || c.caption_en || "") : (c.caption_en || c.caption_ru || ""),
          });
        }
      }
    } else if (s.chart_image_url) {
      charts.push({
        url: s.chart_image_url,
        caption: lang === "ru" ? (s.chart_caption_ru || "") : (s.chart_caption_en || ""),
      });
    }
    return {
      position: s.position,
      is_conclusion: !!s.is_conclusion,
      section_label: lang === "ru" ? (s.section_label_ru || "") : (s.section_label_en || ""),
      headline:      lang === "ru" ? (s.headline_ru || "")      : (s.headline_en || ""),
      body:          lang === "ru" ? (s.body_ru || "")          : (s.body_en || ""),
      charts,
    };
  });

  return {
    id: r.id,
    slug: r.slug,
    report_date: r.report_date,
    report_type: (r.report_type === "weekly" ? "weekly" : "daily"),
    title:    lang === "ru" ? (r.title_ru || r.title_en || "") : (r.title_en || r.title_ru || ""),
    subtitle: lang === "ru" ? (r.subtitle_ru || "") : (r.subtitle_en || ""),
    tags: r.tags || [],
    cover_image_url: r[`cover_image_url_${lang}`] || r.cover_image_url || null,
    sections,
  };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const reportId: string = body.report_id;
    const language: "ru" | "en" = body.language === "en" ? "en" : "ru";
    const unsubToken: string = body.unsubscribe_token || "{{UNSUBSCRIBE_TOKEN}}";

    if (!reportId) {
      return new Response(JSON.stringify({ ok: false, error: "report_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
    const report = await fetchReport(supabase, reportId, language);
    if (!report) {
      return new Response(JSON.stringify({ ok: false, error: "report not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { html, subject, preheader } = renderEmail(report, language, unsubToken);

    return new Response(JSON.stringify({ ok: true, html, subject, preheader }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

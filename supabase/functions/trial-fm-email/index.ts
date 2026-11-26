// trial-fm-email v2
//
// Sends a Founding Member invite email to trial users whose trial ends in ≤3 days.
// Idempotent: skips users who already have trial_fm_email_sent_at set.
// FROM: artem@belfed.com
//
// Manual test params:
//   { "force_email": "x@y.com" }          — send to this address using their DB lang
//   { "force_email": "x@y.com", "force_lang": "en" } — override language
//   { "dry_run": true }                    — preview without sending

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BREVO_API_KEY = Deno.env.get("BREVO_API_KEY") || "";

const FM_LINK_RU = Deno.env.get("TRIBUTE_FM_LINK_RU") || "https://web.tribute.tg/s/XHG";
const FM_LINK_EN = Deno.env.get("TRIBUTE_FM_LINK_EN") || "https://web.tribute.tg/s/XIq";

// Tribute preselects the longest period on its checkout page, so every pay link
// carries a short reminder to pick the period first.
const PERIOD_NOTE_RU = "Обратите внимание: период подписки (1, 3, 6 или 12 месяцев) выбирается на странице оплаты Tribute. По умолчанию там отмечен вариант на 12 месяцев, поэтому перед оплатой выберите нужный вам срок.";
const PERIOD_NOTE_EN = "Please note: you choose the subscription period (1, 3, 6 or 12 months) on the Tribute checkout page. The 12-month option is preselected there, so pick the period you want before paying.";

const FROM_EMAIL = "artem@belfed.com";
const FROM_NAME  = "Artem Fedorov | BelFed";
const REPLY_TO   = "artem@belfed.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ─── HTML templates ───────────────────────────────────────────────

function buildEmailEN(name: string, fmLink: string, unsubToken: string | null): { subject: string; html: string } {
  const subject = "Your BelFed trial & a Founding Member invite";
  const safeN = name ? name.charAt(0).toUpperCase() + name.slice(1) : "there";
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#e8e4da;font-family:'Courier New',Courier,monospace;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#e8e4da;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#f5f2eb;border:1px solid #ddd8ce;">
        <tr><td style="padding:28px 36px 20px 36px;border-bottom:1px solid #d0c9bc;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="font-family:'Courier New',Courier,monospace;font-size:18px;font-weight:700;letter-spacing:1px;color:#1a1a1a;">BELFED_</td>
              <td align="right" style="font-family:'Courier New',Courier,monospace;font-size:11px;color:#999;letter-spacing:2px;">EST. 2025</td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:24px 36px 0 36px;">
          <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:11px;color:#888;letter-spacing:3px;text-transform:uppercase;">// FOUNDING MEMBER &nbsp;&middot;&nbsp; PERSONAL NOTE</p>
        </td></tr>
        <tr><td style="padding:12px 36px 28px 36px;">
          <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:26px;font-weight:700;color:#1a1a1a;line-height:1.3;">For our earliest<br>members.</p>
        </td></tr>
        <tr><td style="padding:0 36px 20px 36px;">
          <p style="margin:0 0 16px 0;font-family:'Courier New',Courier,monospace;font-size:14px;color:#2a2a2a;line-height:1.7;">Hi ${safeN},</p>
          <p style="margin:0 0 16px 0;font-family:'Courier New',Courier,monospace;font-size:14px;color:#2a2a2a;line-height:1.7;">Your BelFed trial ends in <strong>3 days</strong>, and as the founder, I wanted to personally thank you for exploring the markets with us.</p>
          <p style="margin:0 0 16px 0;font-family:'Courier New',Courier,monospace;font-size:14px;color:#2a2a2a;line-height:1.7;">Whether you are trading daily or investing long-term, we highly value our early users. Before we officially close our early-adopter phase, I want to offer you one of our <strong>50 Founding Member seats</strong>.</p>
          <p style="margin:0 0 20px 0;font-family:'Courier New',Courier,monospace;font-size:14px;color:#2a2a2a;line-height:1.7;">If you upgrade today, you will lock in:</p>
        </td></tr>
        <tr><td style="padding:0 36px 24px 36px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ece9e0;border-left:3px solid #1a1a1a;">
            <tr><td style="padding:20px 24px 8px 24px;">
              <p style="margin:0 0 4px 0;font-family:'Courier New',Courier,monospace;font-size:11px;color:#888;letter-spacing:2px;">// 01</p>
              <p style="margin:0 0 16px 0;font-family:'Courier New',Courier,monospace;font-size:13px;color:#1a1a1a;line-height:1.6;"><strong>30% off, forever.</strong> $10.50/mo instead of $15. The discount stays no matter how our pricing changes later.</p>
            </td></tr>
            <tr><td style="padding:0 24px 8px 24px;">
              <p style="margin:0 0 4px 0;font-family:'Courier New',Courier,monospace;font-size:11px;color:#888;letter-spacing:2px;">// 02</p>
              <p style="margin:0 0 16px 0;font-family:'Courier New',Courier,monospace;font-size:13px;color:#1a1a1a;line-height:1.6;"><strong>Priority review of your asset requests</strong> &#8212; your submissions are handled ahead of the standard queue.</p>
            </td></tr>
            <tr><td style="padding:0 24px 20px 24px;">
              <p style="margin:0 0 4px 0;font-family:'Courier New',Courier,monospace;font-size:11px;color:#888;letter-spacing:2px;">// 03</p>
              <p style="margin:0 0 0 0;font-family:'Courier New',Courier,monospace;font-size:13px;color:#1a1a1a;line-height:1.6;"><strong>Founding Member status</strong> tied to your account. Pause anytime &#8212; 60 days to come back without losing the discount or status.</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:0 36px 24px 36px;">
          <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:14px;color:#2a2a2a;line-height:1.7;">There are only <strong>50 seats available</strong>, and the tier will close as soon as they are filled.</p>
        </td></tr>
        <tr><td style="padding:0 36px 24px 36px;">
          <table cellpadding="0" cellspacing="0" border="0">
            <tr><td style="background:#1a1a1a;">
              <a href="${fmLink}" style="display:inline-block;padding:14px 32px;font-family:'Courier New',Courier,monospace;font-size:12px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#f5f2eb;text-decoration:none;">BECOME A FOUNDING MEMBER &#8594;</a>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:0 36px 24px 36px;">
          <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:12px;color:#555;line-height:1.6;">${PERIOD_NOTE_EN}</p>
        </td></tr>
        <tr><td style="padding:0 36px 28px 36px;">
          <p style="margin:0 0 16px 0;font-family:'Courier New',Courier,monospace;font-size:14px;color:#2a2a2a;line-height:1.7;">If the timing isn't right &#8212; no hard feelings. The door stays open whenever it works for you.</p>
          <p style="margin:0 0 16px 0;font-family:'Courier New',Courier,monospace;font-size:14px;color:#2a2a2a;line-height:1.7;">Either way, I appreciate you being here early.</p>
          <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:14px;color:#2a2a2a;line-height:1.7;">Warmly,<br><strong>Artem</strong><br>Founder, BelFed</p>
        </td></tr>
        <tr><td style="padding:20px 36px;border-top:1px solid #d0c9bc;background:#ece9e0;">
          <p style="margin:0 0 8px 0;font-family:'Courier New',Courier,monospace;font-size:12px;font-weight:700;color:#1a1a1a;letter-spacing:1px;">Artem Fedorov &nbsp;&middot;&nbsp; Founder, BelFed</p>
          <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:11px;color:#888;">artem@belfed.com &nbsp;&middot;&nbsp; belfed.com</p>
          <p style="margin:16px 0 0 0;font-family:'Courier New',Courier,monospace;font-size:11px;color:#aaa;line-height:1.6;">${unsubFooterHtml("en", unsubToken)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  return { subject, html };
}

function buildEmailRU(name: string, fmLink: string, unsubToken: string | null): { subject: string; html: string } {
  const subject = "\u0412\u0430\u0448 \u043f\u0440\u043e\u0431\u043d\u044b\u0439 \u043f\u0435\u0440\u0438\u043e\u0434 BelFed \u0438 \u043f\u0440\u0438\u0433\u043b\u0430\u0448\u0435\u043d\u0438\u0435 \u0441\u0442\u0430\u0442\u044c Founding Member";
  const safeN = name ? name.charAt(0).toUpperCase() + name.slice(1) : "";
  const greeting = safeN ? `\u0417\u0434\u0440\u0430\u0432\u0441\u0442\u0432\u0443\u0439\u0442\u0435, ${safeN}!` : "\u0417\u0434\u0440\u0430\u0432\u0441\u0442\u0432\u0443\u0439\u0442\u0435!";
  const html = `<!DOCTYPE html>
<html lang="ru">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#e8e4da;font-family:'Courier New',Courier,monospace;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#e8e4da;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#f5f2eb;border:1px solid #ddd8ce;">
        <tr><td style="padding:28px 36px 20px 36px;border-bottom:1px solid #d0c9bc;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="font-family:'Courier New',Courier,monospace;font-size:18px;font-weight:700;letter-spacing:1px;color:#1a1a1a;">BELFED_</td>
              <td align="right" style="font-family:'Courier New',Courier,monospace;font-size:11px;color:#999;letter-spacing:2px;">EST. 2025</td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:24px 36px 0 36px;">
          <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:11px;color:#888;letter-spacing:3px;text-transform:uppercase;">// FOUNDING MEMBER &nbsp;&middot;&nbsp; \u041b\u0418\u0427\u041d\u041e\u0415 \u0421\u041e\u041e\u0411\u0429\u0415\u041d\u0418\u0415</p>
        </td></tr>
        <tr><td style="padding:12px 36px 28px 36px;">
          <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:26px;font-weight:700;color:#1a1a1a;line-height:1.3;">\u0414\u043b\u044f \u043d\u0430\u0448\u0438\u0445<br>\u043f\u0435\u0440\u0432\u044b\u0445 \u0443\u0447\u0430\u0441\u0442\u043d\u0438\u043a\u043e\u0432.</p>
        </td></tr>
        <tr><td style="padding:0 36px 20px 36px;">
          <p style="margin:0 0 16px 0;font-family:'Courier New',Courier,monospace;font-size:14px;color:#2a2a2a;line-height:1.7;">${greeting}</p>
          <p style="margin:0 0 16px 0;font-family:'Courier New',Courier,monospace;font-size:14px;color:#2a2a2a;line-height:1.7;">\u0412\u0430\u0448 \u043f\u0440\u043e\u0431\u043d\u044b\u0439 \u043f\u0435\u0440\u0438\u043e\u0434 \u0432 BelFed \u0437\u0430\u043a\u0430\u043d\u0447\u0438\u0432\u0430\u0435\u0442\u0441\u044f \u0447\u0435\u0440\u0435\u0437 <strong>3 \u0434\u043d\u044f</strong>, \u0438, \u043a\u0430\u043a \u043e\u0441\u043d\u043e\u0432\u0430\u0442\u0435\u043b\u044c \u043f\u0440\u043e\u0435\u043a\u0442\u0430, \u044f \u0445\u043e\u0442\u0435\u043b \u043b\u0438\u0447\u043d\u043e \u043f\u043e\u0431\u043b\u0430\u0433\u043e\u0434\u0430\u0440\u0438\u0442\u044c \u0432\u0430\u0441 \u0437\u0430 \u0442\u043e, \u0447\u0442\u043e \u0432\u044b \u0440\u0435\u0448\u0438\u043b\u0438 \u043f\u043e\u043f\u0440\u043e\u0431\u043e\u0432\u0430\u0442\u044c \u043d\u0430\u0448 \u0441\u0435\u0440\u0432\u0438\u0441.</p>
          <p style="margin:0 0 16px 0;font-family:'Courier New',Courier,monospace;font-size:14px;color:#2a2a2a;line-height:1.7;">\u041c\u044b \u043e\u0447\u0435\u043d\u044c \u0446\u0435\u043d\u0438\u043c \u043d\u0430\u0448\u0438\u0445 \u043f\u0435\u0440\u0432\u044b\u0445 \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u0435\u0439. \u041f\u0440\u0435\u0436\u0434\u0435 \u0447\u0435\u043c \u043c\u044b \u043e\u0444\u0438\u0446\u0438\u0430\u043b\u044c\u043d\u043e \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u043c \u044d\u0442\u0430\u043f \u0440\u0430\u043d\u043d\u0435\u0433\u043e \u0434\u043e\u0441\u0442\u0443\u043f\u0430, \u044f \u0445\u043e\u0447\u0443 \u043f\u0440\u0435\u0434\u043b\u043e\u0436\u0438\u0442\u044c \u0432\u0430\u043c \u043e\u0434\u043d\u043e \u0438\u0437 <strong>50 \u043c\u0435\u0441\u0442 Founding Member</strong>.</p>
          <p style="margin:0 0 20px 0;font-family:'Courier New',Courier,monospace;font-size:14px;color:#2a2a2a;line-height:1.7;">\u0415\u0441\u043b\u0438 \u0432\u044b \u043f\u0435\u0440\u0435\u0439\u0434\u0451\u0442\u0435 \u043d\u0430 \u044d\u0442\u043e\u0442 \u0442\u0430\u0440\u0438\u0444 \u0441\u0435\u0433\u043e\u0434\u043d\u044f, \u0437\u0430 \u0432\u0430\u043c\u0438 \u0437\u0430\u043a\u0440\u0435\u043f\u044f\u0442\u0441\u044f:</p>
        </td></tr>
        <tr><td style="padding:0 36px 24px 36px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ece9e0;border-left:3px solid #1a1a1a;">
            <tr><td style="padding:20px 24px 8px 24px;">
              <p style="margin:0 0 4px 0;font-family:'Courier New',Courier,monospace;font-size:11px;color:#888;letter-spacing:2px;">// 01</p>
              <p style="margin:0 0 16px 0;font-family:'Courier New',Courier,monospace;font-size:13px;color:#1a1a1a;line-height:1.6;"><strong>\u041f\u043e\u0436\u0438\u0437\u043d\u0435\u043d\u043d\u0430\u044f \u0441\u043a\u0438\u0434\u043a\u0430 30%:</strong> 1&#160;050&#160;&#8381;/\u043c\u0435\u0441 \u0432\u043c\u0435\u0441\u0442\u043e 1&#160;500&#160;&#8381;, \u043d\u0435\u0437\u0430\u0432\u0438\u0441\u0438\u043c\u043e \u043e\u0442 \u043b\u044e\u0431\u044b\u0445 \u0431\u0443\u0434\u0443\u0449\u0438\u0445 \u043f\u043e\u0432\u044b\u0448\u0435\u043d\u0438\u0439 \u0446\u0435\u043d.</p>
            </td></tr>
            <tr><td style="padding:0 24px 8px 24px;">
              <p style="margin:0 0 4px 0;font-family:'Courier New',Courier,monospace;font-size:11px;color:#888;letter-spacing:2px;">// 02</p>
              <p style="margin:0 0 16px 0;font-family:'Courier New',Courier,monospace;font-size:13px;color:#1a1a1a;line-height:1.6;"><strong>\u041f\u0440\u0438\u043e\u0440\u0438\u0442\u0435\u0442\u043d\u0430\u044f \u043e\u0431\u0440\u0430\u0431\u043e\u0442\u043a\u0430 \u0432\u0430\u0448\u0438\u0445 \u0437\u0430\u043f\u0440\u043e\u0441\u043e\u0432 \u043d\u0430 \u0440\u0430\u0437\u0431\u043e\u0440 \u0430\u043a\u0442\u0438\u0432\u043e\u0432</strong> &#8212; \u0432\u0430\u0448\u0438 \u0437\u0430\u044f\u0432\u043a\u0438 \u0440\u0430\u0441\u0441\u043c\u0430\u0442\u0440\u0438\u0432\u0430\u044e\u0442\u0441\u044f \u0432\u043d\u0435 \u043e\u0431\u0449\u0435\u0439 \u043e\u0447\u0435\u0440\u0435\u0434\u0438.</p>
            </td></tr>
            <tr><td style="padding:0 24px 20px 24px;">
              <p style="margin:0 0 4px 0;font-family:'Courier New',Courier,monospace;font-size:11px;color:#888;letter-spacing:2px;">// 03</p>
              <p style="margin:0 0 0 0;font-family:'Courier New',Courier,monospace;font-size:13px;color:#1a1a1a;line-height:1.6;"><strong>\u0421\u0442\u0430\u0442\u0443\u0441 Founding Member</strong> \u043f\u0440\u0438\u0432\u044f\u0437\u0430\u043d \u043a \u0432\u0430\u0448\u0435\u043c\u0443 \u0430\u043a\u043a\u0430\u0443\u043d\u0442\u0443. \u0417\u0430\u043c\u043e\u0440\u043e\u0437\u044c\u0442\u0435 \u043f\u043e\u0434\u043f\u0438\u0441\u043a\u0443 \u043d\u0430 \u0441\u0440\u043e\u043a \u0434\u043e 60 \u0434\u043d\u0435\u0439 \u0431\u0435\u0437 \u043f\u043e\u0442\u0435\u0440\u0438 \u0441\u0442\u0430\u0442\u0443\u0441\u0430 \u0438 \u0441\u043a\u0438\u0434\u043a\u0438.</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:0 36px 24px 36px;">
          <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:14px;color:#2a2a2a;line-height:1.7;">\u0414\u043e\u0441\u0442\u0443\u043f\u043d\u043e \u0432\u0441\u0435\u0433\u043e <strong>50 \u043c\u0435\u0441\u0442</strong>. \u0422\u0430\u0440\u0438\u0444 \u0437\u0430\u043a\u0440\u043e\u0435\u0442\u0441\u044f, \u043a\u0430\u043a \u0442\u043e\u043b\u044c\u043a\u043e \u043e\u043d\u0438 \u0431\u0443\u0434\u0443\u0442 \u0437\u0430\u043f\u043e\u043b\u043d\u0435\u043d\u044b.</p>
        </td></tr>
        <tr><td style="padding:0 36px 24px 36px;">
          <table cellpadding="0" cellspacing="0" border="0">
            <tr><td style="background:#1a1a1a;">
              <a href="${fmLink}" style="display:inline-block;padding:14px 32px;font-family:'Courier New',Courier,monospace;font-size:12px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#f5f2eb;text-decoration:none;">\u0421\u0422\u0410\u0422\u042c FOUNDING MEMBER &#8594;</a>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:0 36px 24px 36px;">
          <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:12px;color:#555;line-height:1.6;">${PERIOD_NOTE_RU}</p>
        </td></tr>
        <tr><td style="padding:0 36px 28px 36px;">
          <p style="margin:0 0 16px 0;font-family:'Courier New',Courier,monospace;font-size:14px;color:#2a2a2a;line-height:1.7;">\u0415\u0441\u043b\u0438 \u0441\u0435\u0439\u0447\u0430\u0441 \u043d\u0435 \u0441\u0430\u043c\u044b\u0439 \u043f\u043e\u0434\u0445\u043e\u0434\u044f\u0449\u0438\u0439 \u043c\u043e\u043c\u0435\u043d\u0442 &#8212; \u043d\u0438\u0447\u0435\u0433\u043e \u0441\u0442\u0440\u0430\u0448\u043d\u043e\u0433\u043e. \u041d\u0430\u0448\u0438 \u0434\u0432\u0435\u0440\u0438 \u0432\u0441\u0435\u0433\u0434\u0430 \u043e\u0442\u043a\u0440\u044b\u0442\u044b.</p>
          <p style="margin:0 0 16px 0;font-family:'Courier New',Courier,monospace;font-size:14px;color:#2a2a2a;line-height:1.7;">\u0412 \u043b\u044e\u0431\u043e\u043c \u0441\u043b\u0443\u0447\u0430\u0435, \u044f \u043f\u0440\u0438\u0437\u043d\u0430\u0442\u0435\u043b\u0435\u043d, \u0447\u0442\u043e \u0432\u044b \u043f\u0440\u0438\u0441\u043e\u0435\u0434\u0438\u043d\u0438\u043b\u0438\u0441\u044c \u043a \u043d\u0430\u043c \u043d\u0430 \u0442\u0430\u043a\u043e\u043c \u0440\u0430\u043d\u043d\u0435\u043c \u044d\u0442\u0430\u043f\u0435.</p>
          <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:14px;color:#2a2a2a;line-height:1.7;">\u0421 \u0443\u0432\u0430\u0436\u0435\u043d\u0438\u0435\u043c,<br><strong>\u0410\u0440\u0442\u0451\u043c</strong><br>\u041e\u0441\u043d\u043e\u0432\u0430\u0442\u0435\u043b\u044c, BelFed</p>
        </td></tr>
        <tr><td style="padding:20px 36px;border-top:1px solid #d0c9bc;background:#ece9e0;">
          <p style="margin:0 0 8px 0;font-family:'Courier New',Courier,monospace;font-size:12px;font-weight:700;color:#1a1a1a;letter-spacing:1px;">\u0410\u0440\u0442\u0451\u043c \u0424\u0435\u0434\u043e\u0440\u043e\u0432 &nbsp;&middot;&nbsp; \u041e\u0441\u043d\u043e\u0432\u0430\u0442\u0435\u043b\u044c, BelFed</p>
          <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:11px;color:#888;">artem@belfed.com &nbsp;&middot;&nbsp; belfed.ru</p>
          <p style="margin:16px 0 0 0;font-family:'Courier New',Courier,monospace;font-size:11px;color:#aaa;line-height:1.6;">${unsubFooterHtml("ru", unsubToken)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  return { subject, html };
}

// ─── Shared opt-out contour (BelFed, 2026-09-01) ──────────────────
// Единый контур отписки: email_subscribers.unsubscribe_token + страница
// {site}/unsubscribe.html?token=... + заголовки List-Unsubscribe.
const SITE_RU_UNSUB = "https://belfed.ru";
const SITE_EN_UNSUB = "https://belfed.com";

function unsubUrlFor(lang: "ru" | "en", token: string | null): string | null {
  if (!token) return null;
  const site = lang === "en" ? SITE_EN_UNSUB : SITE_RU_UNSUB;
  return `${site}/unsubscribe.html?token=${encodeURIComponent(token)}`;
}

// Строка футера с явной ссылкой отписки в один клик.
function unsubFooterHtml(lang: "ru" | "en", token: string | null): string {
  const url = unsubUrlFor(lang, token);
  if (!url) {
    return lang === "en"
      ? `You're receiving this because you signed up for BelFed.`
      : `Вы получили это письмо, потому что зарегистрировались в BelFed.`;
  }
  const label = lang === "en" ? "Unsubscribe" : "Отписаться";
  const intro = lang === "en"
    ? `You're receiving this because you signed up for BelFed.`
    : `Вы получили это письмо, потому что зарегистрировались в BelFed.`;
  return `${intro}<br><a href="${url}" style="color:#888;text-decoration:underline;">${label}</a>`;
}

// RFC 8058: заголовок должен указывать на endpoint, принимающий POST.
// Статическая unsubscribe.html POST обработать не может, поэтому в заголовке
// стоит edge-функция, а видимая ссылка в футере ведёт на страницу.
function unsubApiUrl(token: string | null): string | null {
  if (!token) return null;
  const base = Deno.env.get("SUPABASE_URL") || "";
  if (!base) return null;
  return `${base}/functions/v1/email-unsubscribe?token=${encodeURIComponent(token)}`;
}

function listUnsubHeaders(lang: "ru" | "en", token: string | null): Record<string, string> {
  const apiUrl = unsubApiUrl(token);
  const pageUrl = unsubUrlFor(lang, token);
  if (!apiUrl && !pageUrl) return {};
  const target = apiUrl ?? (pageUrl as string);
  const headers: Record<string, string> = {
    "List-Unsubscribe": `<${target}>`,
  };
  if (apiUrl) headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  return headers;
}


// Telegram-профили без реальной почты получают синтетический адрес
// tg_<id>@belfed.local. Отправка на него — гарантированный hard bounce,
// поэтому такие адреса отсекаются до обращения к Brevo.
const UNDELIVERABLE_DOMAINS = ["belfed.local", "localhost", "example.com", "test"];
function isSendableEmail(email: string | null | undefined): boolean {
  const e = String(email || "").trim().toLowerCase();
  if (!e || !e.includes("@")) return false;
  const domain = e.split("@")[1] || "";
  if (!domain.includes(".")) return false;
  return !UNDELIVERABLE_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

// email_subscribers.source ограничен CHECK-констрейнтом; произвольная метка
// ломала бы вставку молча, поэтому реальный источник уходит в notes.
const ALLOWED_SUBSCRIBER_SOURCES = ["account_signup", "site_form", "admin_import", "manual", "auto_premium"];

interface SubscriberRow {
  id: string;
  unsubscribe_token: string;
  unsubscribed_at: string | null;
  notes: string | null;
}

// Находит или создаёт строку email_subscribers, чтобы у каждого получателя
// был токен отписки. segment ограничен констрейнтом ('premium','leads').
async function resolveSubscriber(
  db: any,
  email: string,
  lang: "ru" | "en",
  profileId: string | null,
  source: string,
): Promise<SubscriberRow | null> {
  const { data } = await db.from("email_subscribers")
    .select("id, unsubscribe_token, unsubscribed_at, notes")
    .eq("email", email)
    .order("created_at", { ascending: true })
    .limit(1);
  if (data && data.length) return data[0] as SubscriberRow;

  const safeSource = ALLOWED_SUBSCRIBER_SOURCES.includes(source) ? source : "account_signup";
  const { data: created, error: insErr } = await db.from("email_subscribers")
    .insert({
      email,
      language: lang,
      segment: "leads",
      source: safeSource,
      notes: safeSource === source ? null : source,
      profile_id: profileId,
      confirmed_at: new Date().toISOString(),
    })
    .select("id, unsubscribe_token, unsubscribed_at, notes")
    .maybeSingle();
  if (insErr) console.error("resolveSubscriber insert failed", email, insErr.message);
  return (created as SubscriberRow) ?? null;
}

// Имя только из явного display_name. Никогда не выводим имя из адреса:
// именно эта эвристика дала «Здравствуйте, www!» 30.08.2026.
const NAME_BLOCKLIST = new Set([
  "www", "mail", "email", "info", "admin", "no-reply", "noreply",
  "support", "contact", "hello", "test", "user",
]);

function safeDisplayName(displayName: unknown): string {
  const raw = typeof displayName === "string" ? displayName.trim() : "";
  if (!raw) return "";
  if (raw.includes("@") || raw.includes("://")) return "";
  if (NAME_BLOCKLIST.has(raw.toLowerCase())) return "";
  if (raw.length > 40) return "";
  return raw;
}

// ─── Brevo send ───────────────────────────────────────────────────

async function sendViaBrevo(toEmail: string, subject: string, html: string, lang: "ru" | "en" = "ru", unsubToken: string | null = null): Promise<{ ok: boolean; error?: string; messageId?: string }> {
  if (!BREVO_API_KEY) return { ok: false, error: "BREVO_API_KEY missing" };
  const payload: Record<string, unknown> = {
    sender: { email: FROM_EMAIL, name: FROM_NAME },
    replyTo: { email: REPLY_TO, name: FROM_NAME },
    to: [{ email: toEmail }],
    subject,
    htmlContent: html,
    tags: ["trial-fm-invite"],
  };
  const unsubHeaders = listUnsubHeaders(lang, unsubToken);
  if (Object.keys(unsubHeaders).length) payload.headers = unsubHeaders;
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "accept": "application/json", "api-key": BREVO_API_KEY, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    return { ok: false, error: `brevo ${r.status}: ${txt.slice(0, 300)}` };
  }
  const j = await r.json().catch(() => ({} as Record<string, unknown>));
  return { ok: true, messageId: String(j.messageId || "") };
}

// ─── Main handler ─────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const dryRun = Boolean(body.dry_run);
  const forceEmail = typeof body.force_email === "string" ? body.force_email.trim().toLowerCase() : null;
  // force_lang overrides DB lang — useful for testing both versions
  const forceLang = typeof body.force_lang === "string" && ["ru","en"].includes(body.force_lang) ? body.force_lang as "ru"|"en" : null;

  const now = new Date();
  const cutoff = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

  let query;
  if (forceEmail) {
    // Force mode: ignore trial status / sent_at, just find by email
    query = admin
      .from("profiles")
      .select("id, email, lang, trial_end, display_name, email_opt_out")
      .eq("email", forceEmail);
  } else {
    query = admin
      .from("profiles")
      .select("id, email, lang, trial_end, display_name, email_opt_out")
      .eq("subscription_status", "trial")
      .is("trial_fm_email_sent_at", null)
      .not("email", "is", null)
      .not("email_opt_out", "is", true)
      .lte("trial_end", cutoff.toISOString())
      .gte("trial_end", now.toISOString());
  }

  const { data: users, error: dbErr } = await query;
  if (dbErr) return json({ ok: false, error: dbErr.message }, 500);
  if (!users || users.length === 0) return json({ ok: true, sent: 0, message: "no eligible users" });

  const results: Array<{ email: string; lang: string; status: string; messageId?: string; error?: string; unsub?: string }> = [];

  for (const user of users) {
    // Use force_lang if provided, otherwise fall back to DB lang
    const lang: "ru" | "en" = forceLang ?? ((user.lang === "en") ? "en" : "ru");
    const fmLink = lang === "en" ? FM_LINK_EN : FM_LINK_RU;
    const email = String(user.email);

    // Жёсткий гейт: профиль, помеченный как отписанный, не получает писем.
    if (!isSendableEmail(email)) {
      results.push({ email, lang, status: "skipped_undeliverable" });
      continue;
    }

    if (user.email_opt_out === true) {
      results.push({ email, lang, status: "skipped_opt_out" });
      continue;
    }

    const subscriber = await resolveSubscriber(admin, email, lang, String(user.id), "trial_fm");
    if (subscriber?.unsubscribed_at) {
      results.push({ email, lang, status: "skipped_unsubscribed" });
      continue;
    }
    const unsubToken = subscriber?.unsubscribe_token ?? null;

    // Имя берём только из display_name, никогда из адреса.
    const name = safeDisplayName(user.display_name);
    const { subject, html } = lang === "en"
      ? buildEmailEN(name, fmLink, unsubToken)
      : buildEmailRU(name, fmLink, unsubToken);

    if (dryRun) {
      results.push({ email, lang, status: "dry_run", unsub: unsubToken ? "ok" : "missing" });
      continue;
    }

    const res = await sendViaBrevo(email, subject, html, lang, unsubToken);
    if (res.ok) {
      if (!forceEmail) {
        // Only mark as sent in production mode (not force_email tests)
        await admin
          .from("profiles")
          .update({ trial_fm_email_sent_at: new Date().toISOString() })
          .eq("id", user.id);
      }
      results.push({ email: user.email as string, lang, status: "sent", messageId: res.messageId });
    } else {
      results.push({ email: user.email as string, lang, status: "error", error: res.error });
    }
  }

  return json({ ok: true, sent: results.filter(r => r.status === "sent").length, results });
});

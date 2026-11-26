// trial-email-reminders v1
//
// Email fallback reminders for trial users WITHOUT a connected Telegram account.
// Stages: d5 (trial ends in 5 days) and d1 (trial ends tomorrow).
// Source of truth: view public.users_for_trial_email_reminder_staged.
// Idempotent via trial_rem_d5_sent_at / trial_rem_d1_sent_at stamps
// (populations are disjoint from the Telegram bot reminders by telegram_id).
//
// Each email carries a one-click Telegram deep link:
//   https://t.me/BelfedBot?start=trial_t_<token>
// The token is a trial_intents row inserted directly with 7-day TTL,
// source = 'trial_email_d5' | 'trial_email_d1'.
//
// Manual test params:
//   { "dry_run": true }                                  — preview without sending
//   { "force_email": "x@y.com" }                         — send to this address (their DB lang), no stamping
//   { "force_email": "x@y.com", "force_lang": "en" }     — override language
//   { "force_email": "x@y.com", "force_stage": 1 }       — override stage (5 or 1), default 5

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

const TRADES_RU = "https://belfed.ru/trades.html";
const TRADES_EN = "https://belfed.com/trades.html";

const BOT_USERNAME = "BelfedBot";

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

// ─── Token generation (same alphabet as trial-intent-create) ──────

const TOKEN_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function generateToken(len = 32): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  return out;
}

// ─── Shared HTML shell ─────────────────────────────────────────────

const F = "font-family:'Courier New',Courier,monospace;";

function shell(langAttr: string, subject: string, kicker: string, headline: string, bodyRows: string, footer: string): string {
  return `<!DOCTYPE html>
<html lang="${langAttr}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#e8e4da;${F}">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#e8e4da;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#f5f2eb;border:1px solid #ddd8ce;">
        <tr><td style="padding:28px 36px 20px 36px;border-bottom:1px solid #d0c9bc;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="${F}font-size:18px;font-weight:700;letter-spacing:1px;color:#1a1a1a;">BELFED_</td>
              <td align="right" style="${F}font-size:11px;color:#999;letter-spacing:2px;">EST. 2025</td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:24px 36px 0 36px;">
          <p style="margin:0;${F}font-size:11px;color:#888;letter-spacing:3px;text-transform:uppercase;">${kicker}</p>
        </td></tr>
        <tr><td style="padding:12px 36px 28px 36px;">
          <p style="margin:0;${F}font-size:26px;font-weight:700;color:#1a1a1a;line-height:1.3;">${headline}</p>
        </td></tr>
        ${bodyRows}
        <tr><td style="padding:20px 36px;border-top:1px solid #d0c9bc;background:#ece9e0;">
          ${footer}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

const P = `margin:0 0 16px 0;${F}font-size:14px;color:#2a2a2a;line-height:1.7;`;

function ctaButton(href: string, label: string): string {
  return `<tr><td style="padding:0 36px 24px 36px;">
    <table cellpadding="0" cellspacing="0" border="0">
      <tr><td style="background:#1a1a1a;">
        <a href="${href}" style="display:inline-block;padding:14px 32px;${F}font-size:12px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#f5f2eb;text-decoration:none;">${label} &#8594;</a>
      </td></tr>
    </table>
  </td></tr>`;
}

function footerRU(unsubToken: string | null): string {
  return `<p style="margin:0 0 8px 0;${F}font-size:12px;font-weight:700;color:#1a1a1a;letter-spacing:1px;">Артём Федоров &nbsp;&middot;&nbsp; Основатель, BelFed</p>
    <p style="margin:0;${F}font-size:11px;color:#888;">artem@belfed.com &nbsp;&middot;&nbsp; belfed.ru</p>
    <p style="margin:16px 0 0 0;${F}font-size:11px;color:#aaa;line-height:1.6;">${unsubFooterHtml("ru", unsubToken)}</p>`;
}

function footerEN(unsubToken: string | null): string {
  return `<p style="margin:0 0 8px 0;${F}font-size:12px;font-weight:700;color:#1a1a1a;letter-spacing:1px;">Artem Fedorov &nbsp;&middot;&nbsp; Founder, BelFed</p>
    <p style="margin:0;${F}font-size:11px;color:#888;">artem@belfed.com &nbsp;&middot;&nbsp; belfed.com</p>
    <p style="margin:16px 0 0 0;${F}font-size:11px;color:#aaa;line-height:1.6;">${unsubFooterHtml("en", unsubToken)}</p>`;
}

// ─── Stage 5 templates ─────────────────────────────────────────────

function buildD5RU(name: string, deepLink: string, unsubToken: string | null): { subject: string; html: string } {
  const subject = "5 дней триала BelFed — подключите Telegram, там доставляются сделки";
  const greeting = name ? `Здравствуйте, ${name}!` : "Здравствуйте!";
  const body = `
    <tr><td style="padding:0 36px 20px 36px;">
      <p style="${P}">${greeting}</p>
      <p style="${P}">Ваш пробный период в BelFed заканчивается через <strong>5 дней</strong> — и я заметил, что вы ещё не подключили Telegram.</p>
      <p style="${P}">Это важно: <strong>все сделки, сигналы и разборы доставляются именно в Telegram</strong> — в закрытую группу и через бота. Без него вы видите только малую часть сервиса.</p>
      <p style="${P}">Подключение занимает 10 секунд — одна кнопка, без кодов и настроек:</p>
    </td></tr>
    ${ctaButton(deepLink, "Подключить Telegram")}
    <tr><td style="padding:0 36px 24px 36px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ece9e0;border-left:3px solid #1a1a1a;">
        <tr><td style="padding:20px 24px;">
          <p style="margin:0 0 4px 0;${F}font-size:11px;color:#888;letter-spacing:2px;">// КСТАТИ</p>
          <p style="margin:0;${F}font-size:13px;color:#1a1a1a;line-height:1.6;">Пока идёт триал, вам доступно одно из <strong>50 мест Founding Member</strong>: пожизненная скидка 30% — 1&#160;050&#160;&#8381;/мес вместо 1&#160;500&#160;&#8381;. <a href="${FM_LINK_RU}" style="color:#1a1a1a;">Закрепить место &#8594;</a></p>
          <p style="margin:10px 0 0 0;${F}font-size:12px;color:#555;line-height:1.6;">${PERIOD_NOTE_RU}</p>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:0 36px 28px 36px;">
      <p style="${P}">Если возникнут вопросы — просто ответьте на это письмо, я читаю всё лично.</p>
      <p style="margin:0;${F}font-size:14px;color:#2a2a2a;line-height:1.7;">С уважением,<br><strong>Артём</strong><br>Основатель, BelFed</p>
    </td></tr>`;
  return { subject, html: shell("ru", subject, "// НАПОМИНАНИЕ &nbsp;&middot;&nbsp; 5 ДНЕЙ ТРИАЛА", "Сделки ждут вас<br>в Telegram.", body, footerRU(unsubToken)) };
}

function buildD5EN(name: string, deepLink: string, unsubToken: string | null): { subject: string; html: string } {
  const subject = "5 days left on your BelFed trial — connect Telegram, that's where trades arrive";
  const safeN = name ? name.charAt(0).toUpperCase() + name.slice(1) : "there";
  const body = `
    <tr><td style="padding:0 36px 20px 36px;">
      <p style="${P}">Hi ${safeN},</p>
      <p style="${P}">Your BelFed trial ends in <strong>5 days</strong> — and I noticed you haven't connected Telegram yet.</p>
      <p style="${P}">This matters: <strong>all trades, signals and breakdowns are delivered in Telegram</strong> — in the private group and via the bot. Without it, you're seeing only a small part of the service.</p>
      <p style="${P}">Connecting takes 10 seconds — one button, no codes or setup:</p>
    </td></tr>
    ${ctaButton(deepLink, "Connect Telegram")}
    <tr><td style="padding:0 36px 24px 36px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ece9e0;border-left:3px solid #1a1a1a;">
        <tr><td style="padding:20px 24px;">
          <p style="margin:0 0 4px 0;${F}font-size:11px;color:#888;letter-spacing:2px;">// BY THE WAY</p>
          <p style="margin:0;${F}font-size:13px;color:#1a1a1a;line-height:1.6;">While your trial is running, one of the <strong>50 Founding Member seats</strong> is available to you: 30% off forever — $10.50/mo instead of $15. <a href="${FM_LINK_EN}" style="color:#1a1a1a;">Lock in your seat &#8594;</a></p>
          <p style="margin:10px 0 0 0;${F}font-size:12px;color:#555;line-height:1.6;">${PERIOD_NOTE_EN}</p>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:0 36px 28px 36px;">
      <p style="${P}">Questions? Just reply to this email — I read everything personally.</p>
      <p style="margin:0;${F}font-size:14px;color:#2a2a2a;line-height:1.7;">Warmly,<br><strong>Artem</strong><br>Founder, BelFed</p>
    </td></tr>`;
  return { subject, html: shell("en", subject, "// REMINDER &nbsp;&middot;&nbsp; 5 DAYS LEFT", "Your trades are waiting<br>in Telegram.", body, footerEN(unsubToken)) };
}

// ─── Stage 1 templates ─────────────────────────────────────────────

function buildD1RU(name: string, deepLink: string, unsubToken: string | null): { subject: string; html: string } {
  const subject = "Триал BelFed заканчивается завтра";
  const greeting = name ? `Здравствуйте, ${name}!` : "Здравствуйте!";
  const body = `
    <tr><td style="padding:0 36px 20px 36px;">
      <p style="${P}">${greeting}</p>
      <p style="${P}">Ваш пробный период в BelFed заканчивается <strong>завтра</strong>. Это последнее письмо перед тем, как доступ закроется.</p>
      <p style="${P}">Если вы так и не успели попробовать главное — все сделки и разборы публикуются в закрытой Telegram-группе. Подключитесь одной кнопкой и посмотрите, за что нас ценят:</p>
    </td></tr>
    ${ctaButton(deepLink, "Подключить Telegram")}
    <tr><td style="padding:0 36px 24px 36px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ece9e0;border-left:3px solid #1a1a1a;">
        <tr><td style="padding:20px 24px;">
          <p style="margin:0 0 4px 0;${F}font-size:11px;color:#888;letter-spacing:2px;">// ПОСЛЕДНИЙ ШАНС</p>
          <p style="margin:0;${F}font-size:13px;color:#1a1a1a;line-height:1.6;">Оффер <strong>Founding Member</strong> действует только пока идёт триал: пожизненная скидка 30% — 1&#160;050&#160;&#8381;/мес вместо 1&#160;500&#160;&#8381;, приоритетные разборы ваших активов и статус за аккаунтом. Всего 50 мест. <a href="${FM_LINK_RU}" style="color:#1a1a1a;font-weight:700;">Закрепить место &#8594;</a></p>
          <p style="margin:10px 0 0 0;${F}font-size:12px;color:#555;line-height:1.6;">${PERIOD_NOTE_RU}</p>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:0 36px 28px 36px;">
      <p style="${P}">Сомневаетесь, стоит ли? Вся история наших сделок открыта: <a href="${TRADES_RU}" style="color:#1a1a1a;">belfed.ru/trades</a> — посмотрите результаты и решите сами.</p>
      <p style="${P}">Если сейчас не время — ничего страшного, двери открыты. Спасибо, что попробовали.</p>
      <p style="margin:0;${F}font-size:14px;color:#2a2a2a;line-height:1.7;">С уважением,<br><strong>Артём</strong><br>Основатель, BelFed</p>
    </td></tr>`;
  return { subject, html: shell("ru", subject, "// НАПОМИНАНИЕ &nbsp;&middot;&nbsp; ПОСЛЕДНИЙ ДЕНЬ", "Завтра доступ<br>закроется.", body, footerRU(unsubToken)) };
}

function buildD1EN(name: string, deepLink: string, unsubToken: string | null): { subject: string; html: string } {
  const subject = "Your BelFed trial ends tomorrow";
  const safeN = name ? name.charAt(0).toUpperCase() + name.slice(1) : "there";
  const body = `
    <tr><td style="padding:0 36px 20px 36px;">
      <p style="${P}">Hi ${safeN},</p>
      <p style="${P}">Your BelFed trial ends <strong>tomorrow</strong>. This is the last note before access closes.</p>
      <p style="${P}">If you never got to the core of the service — every trade and breakdown is published in the private Telegram group. Connect with one tap and see what members value us for:</p>
    </td></tr>
    ${ctaButton(deepLink, "Connect Telegram")}
    <tr><td style="padding:0 36px 24px 36px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ece9e0;border-left:3px solid #1a1a1a;">
        <tr><td style="padding:20px 24px;">
          <p style="margin:0 0 4px 0;${F}font-size:11px;color:#888;letter-spacing:2px;">// LAST CHANCE</p>
          <p style="margin:0;${F}font-size:13px;color:#1a1a1a;line-height:1.6;">The <strong>Founding Member</strong> offer is only valid while your trial is active: 30% off forever — $10.50/mo instead of $15, priority reviews of your asset requests, status tied to your account. Only 50 seats. <a href="${FM_LINK_EN}" style="color:#1a1a1a;font-weight:700;">Lock in your seat &#8594;</a></p>
          <p style="margin:10px 0 0 0;${F}font-size:12px;color:#555;line-height:1.6;">${PERIOD_NOTE_EN}</p>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:0 36px 28px 36px;">
      <p style="${P}">Not sure it's worth it? Our full trade history is public: <a href="${TRADES_EN}" style="color:#1a1a1a;">belfed.com/trades</a> — check the results and decide for yourself.</p>
      <p style="${P}">If the timing isn't right — no hard feelings, the door stays open. Thanks for giving us a try.</p>
      <p style="margin:0;${F}font-size:14px;color:#2a2a2a;line-height:1.7;">Warmly,<br><strong>Artem</strong><br>Founder, BelFed</p>
    </td></tr>`;
  return { subject, html: shell("en", subject, "// REMINDER &nbsp;&middot;&nbsp; FINAL DAY", "Access closes<br>tomorrow.", body, footerEN(unsubToken)) };
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

async function sendViaBrevo(toEmail: string, subject: string, html: string, tag: string, lang: "ru" | "en" = "ru", unsubToken: string | null = null): Promise<{ ok: boolean; error?: string; messageId?: string }> {
  if (!BREVO_API_KEY) return { ok: false, error: "BREVO_API_KEY missing" };
  const payload: Record<string, unknown> = {
    sender: { email: FROM_EMAIL, name: FROM_NAME },
    replyTo: { email: REPLY_TO, name: FROM_NAME },
    to: [{ email: toEmail }],
    subject,
    htmlContent: html,
    tags: [tag],
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

// ─── Intent creation (direct insert, 7-day TTL) ───────────────────

async function createIntent(email: string, lang: string, stage: number): Promise<{ ok: boolean; deepLink?: string; error?: string }> {
  const token = generateToken(32);
  const source = stage === 1 ? "trial_email_d1" : "trial_email_d5";
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await admin.from("trial_intents").insert({
    token,
    email,
    lang,
    source,
    intent_type: "trial",
    expires_at: expiresAt,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, deepLink: `https://t.me/${BOT_USERNAME}?start=trial_t_${token}` };
}

// ─── Main handler ─────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const dryRun = Boolean(body.dry_run);
  const forceEmail = typeof body.force_email === "string" ? body.force_email.trim().toLowerCase() : null;
  const forceLang = typeof body.force_lang === "string" && ["ru", "en"].includes(body.force_lang) ? body.force_lang as "ru" | "en" : null;
  const forceStage = body.force_stage === 1 || body.force_stage === 5 ? body.force_stage as number : null;

  type Row = { user_id: string; email: string; lang: string; trial_end: string; stage: number };
  let rows: Row[] = [];

  if (forceEmail) {
    const { data: prof, error: pErr } = await admin
      .from("profiles")
      .select("id, email, lang, trial_end")
      .eq("email", forceEmail)
      .maybeSingle();
    if (pErr) return json({ ok: false, error: pErr.message }, 500);
    if (!prof) return json({ ok: false, error: "profile_not_found" }, 404);
    rows = [{
      user_id: prof.id as string,
      email: prof.email as string,
      lang: (prof.lang as string) || "ru",
      trial_end: (prof.trial_end as string) || "",
      stage: forceStage ?? 5,
    }];
  } else {
    const { data, error: vErr } = await admin
      .from("users_for_trial_email_reminder_staged")
      .select("user_id, email, lang, trial_end, stage");
    if (vErr) return json({ ok: false, error: vErr.message }, 500);
    rows = (data || []) as Row[];
  }

  if (rows.length === 0) return json({ ok: true, sent: 0, message: "no eligible users" });

  const results: Array<{ email: string; lang: string; stage: number; status: string; messageId?: string; error?: string }> = [];

  for (const row of rows) {
    const lang: "ru" | "en" = forceLang ?? ((row.lang === "en") ? "en" : "ru");

    // Гейт отписки: флаг в профиле и статус в email_subscribers.
    const { data: prof } = await admin
      .from("profiles")
      .select("display_name, email_opt_out")
      .eq("id", row.user_id)
      .maybeSingle();
    if (!isSendableEmail(row.email)) {
      results.push({ email: row.email, lang, stage: row.stage, status: "skipped_undeliverable" });
      continue;
    }

    if (prof?.email_opt_out === true) {
      results.push({ email: row.email, lang, stage: row.stage, status: "skipped_opt_out" });
      continue;
    }
    const subscriber = await resolveSubscriber(admin, row.email, lang, row.user_id, "trial_email_reminder");
    if (subscriber?.unsubscribed_at) {
      results.push({ email: row.email, lang, stage: row.stage, status: "skipped_unsubscribed" });
      continue;
    }
    const unsubToken = subscriber?.unsubscribe_token ?? null;
    // Имя только из display_name, никогда из адреса.
    const name = safeDisplayName(prof?.display_name);

    if (dryRun) {
      results.push({ email: row.email, lang, stage: row.stage, status: "dry_run" });
      continue;
    }

    // 1) Create one-click deep-link intent (7-day TTL)
    const intent = await createIntent(row.email, lang, row.stage);
    if (!intent.ok) {
      results.push({ email: row.email, lang, stage: row.stage, status: "error", error: `intent: ${intent.error}` });
      continue;
    }

    // 2) Build email
    const builder = row.stage === 1
      ? (lang === "en" ? buildD1EN : buildD1RU)
      : (lang === "en" ? buildD5EN : buildD5RU);
    const { subject, html } = builder(name, intent.deepLink!, unsubToken);

    // 3) Send
    const tag = row.stage === 1 ? "trial-email-d1" : "trial-email-d5";
    const res = await sendViaBrevo(row.email, subject, html, tag, lang, unsubToken);
    if (res.ok) {
      if (!forceEmail) {
        const stampCol = row.stage === 1 ? "trial_rem_d1_sent_at" : "trial_rem_d5_sent_at";
        await admin
          .from("profiles")
          .update({ [stampCol]: new Date().toISOString() })
          .eq("id", row.user_id);
      }
      results.push({ email: row.email, lang, stage: row.stage, status: "sent", messageId: res.messageId });
    } else {
      results.push({ email: row.email, lang, stage: row.stage, status: "error", error: res.error });
    }
  }

  return json({ ok: true, sent: results.filter(r => r.status === "sent").length, results });
});

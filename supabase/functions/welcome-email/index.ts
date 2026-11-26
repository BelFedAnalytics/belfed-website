// welcome-email
//
// Sends a one-time welcome email with three clear next steps:
//   1) Log in to the member cabinet
//   2) Connect Telegram for live trade alerts (optional)
//   3) Pay / secure the founding subscription
//
// Called by the website right after sign-up (anon key, no JWT).
// Idempotent-ish: best-effort, rate-limited per email per hour via welcome_email_log.
// Email provider: Brevo (BREVO_API_KEY), FROM noreply@belfed.com.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BREVO_API_KEY = Deno.env.get("BREVO_API_KEY") || "";

const FROM_EMAIL = "noreply@belfed.com";
const FROM_NAME = "BelFed Analytics";
const REPLY_TO = "contact@belfed.com";
const SITE_RU = "https://belfed.ru";
const SITE_EN = "https://belfed.com";
const BOT_URL = "https://t.me/BelfedBot?start=link";
const PAY_RU = "https://web.tribute.tg/s/XHG";
const PAY_EN = "https://web.tribute.tg/s/XIq";

// Tribute preselects the longest period on its checkout page, so every pay link
// carries a short reminder to pick the period first.
const PERIOD_NOTE_RU = "Обратите внимание: период подписки (1, 3, 6 или 12 месяцев) выбирается на странице оплаты Tribute. По умолчанию там отмечен вариант на 12 месяцев, поэтому перед оплатой выберите нужный вам срок.";
const PERIOD_NOTE_EN = "Please note: you choose the subscription period (1, 3, 6 or 12 months) on the Tribute checkout page. The 12-month option is preselected there, so pick the period you want before paying.";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
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

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

interface Strings {
  subject: string;
  preheader: string;
  heading: string;
  intro: string;
  step1_label: string; step1_title: string; step1_desc: string; step1_btn: string;
  step2_label: string; step2_title: string; step2_desc: string; step2_btn: string;
  step3_label: string; step3_title: string; step3_desc: string; step3_btn: string;
  footer: string;
}

const RU: Strings = {
  subject: "Добро пожаловать в BelFed — ваш доступ открыт",
  preheader: "Личный кабинет открыт на 7 дней. Вот три простых шага.",
  heading: "Добро пожаловать в BelFed",
  intro: "Ваш аккаунт создан, а пробный доступ к личному кабинету активен на 7 дней. Вот три простых шага, чтобы начать:",
  step1_label: "Шаг 1 — Личный кабинет",
  step1_title: "Войдите в кабинет",
  step1_desc: "Трекер позиций, аналитика и управление подпиской — всё в одном месте.",
  step1_btn: "Открыть кабинет",
  step2_label: "Шаг 2 — Telegram (по желанию)",
  step2_title: "Подключите онлайн-уведомления",
  step2_desc: "Получайте алерты о сделках в реальном времени и доступ в закрытую группу. Кабинет работает и без этого.",
  step2_btn: "Подключить Telegram",
  step3_label: "Шаг 3 — Подписка",
  step3_title: "Оформите Founding Member",
  step3_desc: "1 050 ₽/мес, −30% навсегда. Сначала идёт бесплатный пробный период — карта не нужна.",
  step3_btn: "Оформить подписку",
  footer: "Если вы не регистрировались на BelFed, просто проигнорируйте это письмо.",
};

const EN: Strings = {
  subject: "Welcome to BelFed — your access is live",
  preheader: "Your member area is open for 7 days. Here are three simple steps.",
  heading: "Welcome to BelFed",
  intro: "Your account is created and your 7-day trial to the member area is active. Here are three simple steps to get started:",
  step1_label: "Step 1 — Member area",
  step1_title: "Log in to your cabinet",
  step1_desc: "Position tracker, analytics and subscription management — all in one place.",
  step1_btn: "Open member area",
  step2_label: "Step 2 — Telegram (optional)",
  step2_title: "Connect live alerts",
  step2_desc: "Get real-time trade alerts and access to the private group. The cabinet works without it.",
  step2_btn: "Connect Telegram",
  step3_label: "Step 3 — Subscription",
  step3_title: "Secure your Founding Member price",
  step3_desc: "$10.5/mo, −30% forever. Your free trial runs first — no card needed.",
  step3_btn: "Subscribe",
  footer: "If you didn't sign up for BelFed, just ignore this email.",
};

function ctaButton(text: string, url: string): string {
  return `<a href="${url}" style="display:inline-block;padding:12px 22px;background:#000;color:#f5f2eb;text-decoration:none;font-family:'Courier New',monospace;font-size:11px;letter-spacing:2px;text-transform:uppercase;border:1px solid #000">${escapeHtml(text)}</a>`;
}

function stepBlock(label: string, title: string, desc: string, btn: string, url: string, note = ""): string {
  return `
    <div style="margin:0 0 22px 0;padding:18px 20px;background:#faf8f1;border-left:3px solid #000">
      <div style="font-family:'Courier New',monospace;font-size:11px;letter-spacing:2px;color:#666;margin-bottom:6px">// ${escapeHtml(label).toUpperCase()}</div>
      <div style="font-size:17px;font-weight:700;margin-bottom:6px">${escapeHtml(title)}</div>
      <div style="font-size:14px;line-height:1.6;color:#333;margin-bottom:14px">${escapeHtml(desc)}</div>
      ${ctaButton(btn, url)}${note ? `
      <div style="font-size:12px;line-height:1.6;color:#666;margin-top:14px">${escapeHtml(note)}</div>` : ""}
    </div>`;
}

function buildHtml(lang: "ru" | "en", unsubToken: string | null): { subject: string; html: string } {
  const t = lang === "en" ? EN : RU;
  const site = lang === "en" ? SITE_EN : SITE_RU;
  const pay = lang === "en" ? PAY_EN : PAY_RU;
  const inner = `
    <h1 style="margin:0 0 14px 0;font-size:24px;font-weight:700;letter-spacing:-0.3px">${escapeHtml(t.heading)}</h1>
    <p style="font-size:14px;line-height:1.7;color:#333;margin:0 0 22px 0">${escapeHtml(t.intro)}</p>
    ${stepBlock(t.step1_label, t.step1_title, t.step1_desc, t.step1_btn, `${site}/members.html`)}
    ${stepBlock(t.step2_label, t.step2_title, t.step2_desc, t.step2_btn, BOT_URL)}
    ${stepBlock(t.step3_label, t.step3_title, t.step3_desc, t.step3_btn, pay, lang === "en" ? PERIOD_NOTE_EN : PERIOD_NOTE_RU)}
  `;
  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BelFed Analytics</title></head>
<body style="margin:0;padding:0;background:#f5f2eb;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Helvetica,Arial,sans-serif;color:#0a0a0a">
<div style="display:none;max-height:0;overflow:hidden;color:#f5f2eb">${escapeHtml(t.preheader)}</div>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#f5f2eb">
  <tr><td align="center" style="padding:32px 12px">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width:600px;background:#ffffff;border:2px solid #000">
      <tr><td style="padding:24px 28px;border-bottom:2px solid #000">
        <div style="font-family:'Courier New',monospace;font-size:12px;letter-spacing:3px;color:#000">BELFED&nbsp;//&nbsp;ANALYTICS</div>
      </td></tr>
      <tr><td style="padding:28px">${inner}</td></tr>
      <tr><td style="padding:18px 28px;border-top:1px dashed #ccc;font-size:11px;color:#666;line-height:1.6">${escapeHtml(t.footer)}<br>${unsubFooterHtml(lang, unsubToken)}</td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
  return { subject: t.subject, html };
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

async function sendViaBrevo(toEmail: string, subject: string, html: string, lang: "ru" | "en" = "ru", unsubToken: string | null = null) {
  if (!BREVO_API_KEY) return { ok: false, error: "BREVO_API_KEY missing" };
  const payload: Record<string, unknown> = {
    sender: { email: FROM_EMAIL, name: FROM_NAME },
    replyTo: { email: REPLY_TO, name: FROM_NAME },
    to: [{ email: toEmail }],
    subject,
    htmlContent: html,
    tags: ["welcome"],
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
  const j = await r.json().catch(() => ({} as any));
  return { ok: true, messageId: j.messageId || "" };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const body = await req.json().catch(() => ({}));
  const email = String(body.email || "").trim().toLowerCase();
  let lang = String(body.lang || "ru").toLowerCase();
  if (lang !== "ru" && lang !== "en") lang = "ru";

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ ok: false, error: "invalid_email" }, 400);
  }

  // Rate-limit: at most one welcome email per address per hour.
  try {
    const { data: recent } = await admin
      .from("welcome_email_log")
      .select("sent_at")
      .eq("email", email)
      .gte("sent_at", new Date(Date.now() - 3600_000).toISOString())
      .limit(1);
    if (recent && recent.length > 0) {
      return json({ ok: true, skipped: "rate_limited" });
    }
  } catch (_e) { /* table may not exist yet; proceed */ }

  // Гейт отписки: профиль с email_opt_out и отписанный подписчик не получают писем.
  const { data: prof } = await admin
    .from("profiles")
    .select("id, email_opt_out")
    .eq("email", email)
    .maybeSingle();
  if (!isSendableEmail(email)) return json({ ok: true, skipped: "undeliverable", email });
  if (prof?.email_opt_out === true) return json({ ok: true, skipped: "opt_out" });

  const subscriber = await resolveSubscriber(admin, email, lang as "ru" | "en", (prof?.id as string) ?? null, "welcome_email");
  if (subscriber?.unsubscribed_at) return json({ ok: true, skipped: "unsubscribed" });
  const unsubToken = subscriber?.unsubscribe_token ?? null;

  const { subject, html } = buildHtml(lang as "ru" | "en", unsubToken);
  const res = await sendViaBrevo(email, subject, html, lang as "ru" | "en", unsubToken);
  if (!res.ok) return json({ ok: false, error: res.error }, 502);

  try {
    await admin.from("welcome_email_log").insert({ email, lang, sent_at: new Date().toISOString() });
  } catch (_e) { /* logging is best-effort */ }

  return json({ ok: true, messageId: (res as any).messageId || "" });
});

// research-subscribe v1 (2026-10-30): free email subscription from /research/.
//
// Double opt-in:
//   POST {email, lang, consent:true, page, website}  -> stores a pending request in
//        research_email_optins (consent text + version as proof) and emails a
//        confirmation link. Same response whether or not the address is known.
//   The email links to https://belfed.{ru|com}/research/?confirm=<token>; the page
//   then POSTs {action:"confirm", token}. Link scanners that only GET the URL
//   cannot confirm on the user's behalf. Confirm creates or reactivates
//   email_subscribers (segment 'leads', source 'site_form').
//
// Confirmed subscribers receive report emails through analytics-email-send for
// reports where "send to leads" is enabled. Unsubscribe uses the shared token flow.
// verify_jwt=false (public form). Anti-abuse: honeypot, per-IP and per-email limits.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BREVO_API_KEY = Deno.env.get("BREVO_API_KEY") || "";

const FROM_EMAIL = "noreply@belfed.com";
const FROM_NAME = "BelFed Analytics";
const REPLY_TO = "contact@belfed.com";
const CONSENT_VERSION = "research_email_v1_2026-10-30";

const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });

type Lang = "ru" | "en";

// Must match the checkbox label on /research/ (stored as proof of consent).
const CONSENT_TEXT: Record<Lang, string> = {
  ru: "Я согласен получать на email бесплатные исследования BelFed Analytics. Отписаться можно в один клик в любом письме.",
  en: "I agree to receive free Belfed Analytics research by email. I can unsubscribe in one click from any email.",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", ...CORS } });
}
function site(lang: Lang): string { return lang === "ru" ? "https://belfed.ru" : "https://belfed.com"; }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const BLOCKED_DOMAINS = ["belfed.local", "localhost", "example.com", "test"];

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function randomToken(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}
function esc(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

function confirmEmail(lang: Lang, link: string): { subject: string; html: string } {
  const c = lang === "ru" ? {
    subject: "Подтвердите подписку на исследования BelFed",
    pre: "Один клик, и бесплатные отчёты будут приходить на почту.",
    h: "Подтвердите подписку",
    p: "Вы (или кто-то от вашего имени) подписали этот адрес на бесплатные исследования BelFed Analytics на сайте belfed.ru. Нажмите кнопку, чтобы подтвердить.",
    btn: "Подтвердить подписку",
    alt: "Если кнопка не работает, откройте ссылку:",
    ign: "Если вы не подписывались, просто проигнорируйте это письмо: без подтверждения мы ничего присылать не будем. Ссылка действует 72 часа.",
    disc: "BelFed Analytics публикует независимые рыночные исследования. Это не инвестиционная рекомендация.",
  } : {
    subject: "Confirm your Belfed research subscription",
    pre: "One click and free reports will arrive in your inbox.",
    h: "Confirm your subscription",
    p: "You (or someone using your address) subscribed this email to free Belfed Analytics research on belfed.com. Click the button to confirm.",
    btn: "Confirm subscription",
    alt: "If the button does not work, open this link:",
    ign: "If you did not sign up, just ignore this email: without confirmation we will not send you anything. The link is valid for 72 hours.",
    disc: "Belfed Analytics publishes independent market research. It is not investment advice.",
  };
  const html = `<!DOCTYPE html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(c.subject)}</title></head>
<body style="margin:0;padding:0;background:#f5f5f0;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(c.pre)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f0;"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e3e3dc;">
<tr><td style="padding:24px 32px;border-bottom:1px solid #e3e3dc;font-family:'Courier New',monospace;font-size:16px;letter-spacing:4px;font-weight:bold;color:#0a0a0a;">BELFED_</td></tr>
<tr><td style="padding:32px;font-family:Georgia,'Times New Roman',serif;color:#0a0a0a;">
<p style="margin:0 0 8px;font-family:'Courier New',monospace;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#14542d;">// ${lang === "ru" ? "Бесплатные исследования" : "Free research"}</p>
<h1 style="margin:0 0 16px;font-size:26px;line-height:1.25;font-weight:600;">${esc(c.h)}</h1>
<p style="margin:0 0 24px;font-size:17px;line-height:1.6;color:#333333;">${esc(c.p)}</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#0a0a0a;"><a href="${esc(link)}" style="display:inline-block;padding:14px 24px;font-family:'Courier New',monospace;font-size:13px;letter-spacing:2px;text-transform:uppercase;font-weight:bold;color:#f5f5f0;text-decoration:none;">${esc(c.btn)}</a></td></tr></table>
<p style="margin:24px 0 4px;font-size:14px;line-height:1.5;color:#555555;">${esc(c.alt)}</p>
<p style="margin:0 0 24px;font-family:'Courier New',monospace;font-size:12px;line-height:1.5;word-break:break-all;"><a href="${esc(link)}" style="color:#14542d;">${esc(link)}</a></p>
<p style="margin:0;font-size:14px;line-height:1.6;color:#555555;">${esc(c.ign)}</p>
</td></tr>
<tr><td style="padding:20px 32px;border-top:1px solid #e3e3dc;font-family:'Courier New',monospace;font-size:11px;line-height:1.6;color:#6b6b6b;">${esc(c.disc)}<br><a href="${site(lang)}/privacy.html" style="color:#6b6b6b;">${lang === "ru" ? "Политика конфиденциальности" : "Privacy policy"}</a></td></tr>
</table></td></tr></table></body></html>`;
  return { subject: c.subject, html };
}

async function sendBrevo(to: string, subject: string, html: string): Promise<boolean> {
  if (!BREVO_API_KEY) { console.error("BREVO_API_KEY missing"); return false; }
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { accept: "application/json", "api-key": BREVO_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ sender: { email: FROM_EMAIL, name: FROM_NAME }, replyTo: { email: REPLY_TO, name: FROM_NAME }, to: [{ email: to }], subject, htmlContent: html, tags: ["research-optin"] }),
  });
  if (!r.ok) console.error("brevo", r.status, (await r.text().catch(() => "")).slice(0, 300));
  return r.ok;
}

async function handleSubscribe(req: Request, body: Record<string, unknown>): Promise<Response> {
  if (typeof body.website === "string" && body.website.trim()) return json({ ok: true, status: "pending" });
  const lang: Lang = body.lang === "ru" ? "ru" : "en";
  const email = String(body.email ?? "").trim().toLowerCase().slice(0, 254);
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: "invalid_email" }, 400);
  const domain = email.split("@")[1];
  if (BLOCKED_DOMAINS.some(d => domain === d || domain.endsWith("." + d))) return json({ ok: false, error: "invalid_email" }, 400);
  if (body.consent !== true) return json({ ok: false, error: "consent_required" }, 400);

  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "";
  const ipHash = ip ? (await sha256(`research-subscribe:${ip}`)).slice(0, 32) : null;
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const dayAgo = new Date(Date.now() - 86400_000).toISOString();
  if (ipHash) {
    const { count } = await db.from("research_email_optins").select("id", { count: "exact", head: true }).eq("ip_hash", ipHash).gte("created_at", hourAgo);
    if ((count ?? 0) >= 8) return json({ ok: false, error: "rate_limited" }, 429);
  }
  const { count: perEmail } = await db.from("research_email_optins").select("id", { count: "exact", head: true }).eq("email", email).gte("created_at", dayAgo);
  // Same answer either way, so the form never reveals whether an address is known.
  if ((perEmail ?? 0) >= 3) return json({ ok: true, status: "pending" });

  const token = randomToken();
  const { data: row, error } = await db.from("research_email_optins").insert({
    email, lang, token_hash: await sha256(token),
    consent_text: CONSENT_TEXT[lang], consent_version: CONSENT_VERSION,
    page: String(body.page ?? "").slice(0, 200) || null,
    ip_hash: ipHash, user_agent: String(req.headers.get("user-agent") ?? "").slice(0, 300),
  }).select("id").single();
  if (error || !row) { console.error("optin insert", error?.message); return json({ ok: false, error: "server_error" }, 500); }

  const link = `${site(lang)}/research/?confirm=${token}#rsSub`;
  const m = confirmEmail(lang, link);
  const sent = await sendBrevo(email, m.subject, m.html);
  if (!sent) return json({ ok: false, error: "send_failed" }, 502);
  await db.from("research_email_optins").update({ email_sent_at: new Date().toISOString() }).eq("id", row.id);
  return json({ ok: true, status: "pending" });
}

async function handleConfirm(token: string): Promise<Response> {
  if (!/^[a-f0-9]{48}$/.test(token)) return json({ ok: false, error: "expired" });
  const { data: opt } = await db.from("research_email_optins")
    .select("id, email, lang, expires_at, confirmed_at, subscriber_id").eq("token_hash", await sha256(token)).maybeSingle();
  if (!opt) return json({ ok: false, error: "expired" });
  const lang: Lang = opt.lang === "ru" ? "ru" : "en";
  if (opt.confirmed_at) return json({ ok: true, status: "confirmed", lang });
  if (new Date(opt.expires_at).getTime() < Date.now()) return json({ ok: false, error: "expired" });

  const now = new Date().toISOString();
  const note = `research_subscribe ${CONSENT_VERSION} optin=${opt.id}`;
  const { data: existing } = await db.from("email_subscribers")
    .select("id, segment, unsubscribed_at, notes").eq("email", opt.email).order("created_at", { ascending: true }).limit(1);
  let subscriberId: string | null = null;
  if (existing && existing.length) {
    const s = existing[0];
    subscriberId = s.id;
    // Explicit, confirmed opt-in: reactivate. Premium members keep their segment.
    const patch: Record<string, unknown> = { notify_analytics: true, updated_at: now, notes: [s.notes, note].filter(Boolean).join(" | ").slice(0, 1000) };
    if (s.unsubscribed_at) { patch.unsubscribed_at = null; patch.confirmed_at = now; }
    const { error } = await db.from("email_subscribers").update(patch).eq("id", s.id);
    if (error) { console.error("subscriber update", error.message); return json({ ok: false, error: "server_error" }, 500); }
  } else {
    const { data: created, error } = await db.from("email_subscribers").insert({
      email: opt.email, language: lang, segment: "leads", source: "site_form",
      subscribed_at: now, confirmed_at: now, notify_analytics: true, notes: note,
    }).select("id").single();
    if (error || !created) { console.error("subscriber insert", error?.message); return json({ ok: false, error: "server_error" }, 500); }
    subscriberId = created.id;
  }
  await db.from("research_email_optins").update({ confirmed_at: now, subscriber_id: subscriberId }).eq("id", opt.id);
  return json({ ok: true, status: "confirmed", lang });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  try {
    if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
    if (body.action === "confirm") return await handleConfirm(String(body.token ?? ""));
    return await handleSubscribe(req, body);
  } catch (e) {
    console.error("research-subscribe", e instanceof Error ? e.message : String(e));
    return json({ ok: false, error: "server_error" }, 500);
  }
});

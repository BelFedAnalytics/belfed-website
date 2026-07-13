// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: trial-intent-create
//
// Called by the public website (belfed.com /trial.html or belfed.ru /ru/trial.html)
// when a visitor submits the "Start free trial" form (email + privacy/terms consent).
//
// Flow:
//   1. Browser POSTs { email, lang, source, intent_type } and required consent flags
//   2. We validate email and consent flags
//   3. Optional rate-limit: max 5 requests / IP / hour (best-effort, in trial_intents history)
//   4. Generate one-time token (32-char URL-safe base32-ish), store in trial_intents
//   5. Return Telegram deep-link: https://t.me/<BOT_USERNAME>?start=trial_t_<TOKEN>
//
// Auth: PUBLIC (no auth header required; CORS open). Token is the only secret we issue.
//
// Secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TELEGRAM_BOT_USERNAME    e.g. "BelfedBot"   (no @)
//   TRIAL_INTENT_TTL_MIN     optional, default 15
//
// ── ATTRIBUTION ADD-ON (this repo) ────────────────────────────────────────
// This file is the LIVE deployed source (version 5) with a single additive
// block: it re-sanitizes the marketing attribution posted by the browser
// (anonymous_id / attribution_key / first_touch / last_touch / landing_page),
// persists it onto the trial_intents row, and writes the idempotent 'signup'
// conversion event via record_signup_attribution. NONE of the existing business
// logic (rate-limit, token gen, consent handling, collision retry, response
// shape, wildcard CORS) is changed. Attribution is best-effort: if it fails,
// the trial intent still succeeds. No PII (email/consent) is ever written to
// the conversion tables — buildAttributionPayload drops everything but the
// UTM/referrer/landing_page allowlist server-side.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildAttributionPayload } from "../_shared/attribution.ts";

const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_USERNAME          = Deno.env.get("TELEGRAM_BOT_USERNAME") ?? "BelfedBot";
const TTL_MIN               = parseInt(Deno.env.get("TRIAL_INTENT_TTL_MIN") ?? "15", 10);

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// 32-char base32-safe token
function genToken(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o/1/l/i confusion
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < buf.length; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

function getClientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim().slice(0, 64);
  const real = req.headers.get("x-real-ip");
  if (real) return real.slice(0, 64);
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")    return new Response("Method Not Allowed", { status: 405, headers: cors });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  // ---- Validate input ----
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const langRaw = String(body?.lang ?? "ru").toLowerCase();
  const lang = (langRaw === "en") ? "en" : "ru";
  const source = (typeof body?.source === "string" && body.source.trim()) ? body.source.trim().slice(0, 64) : "trial_web";
  const intentType = body?.intent_type === "stars_upgrade" ? "stars_upgrade" : "trial";
  const acceptedPrivacy = body?.accept_privacy === true;
  const acceptedTerms   = body?.accept_terms   === true;

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json({ ok: false, error: "invalid_email" }, 400);
  }
  if (!acceptedPrivacy || !acceptedTerms) {
    return json({ ok: false, error: "consent_required" }, 400);
  }
  // Block synthetic ghost emails
  if (email.endsWith("@belfed.local")) {
    return json({ ok: false, error: "invalid_email" }, 400);
  }

  const ip = getClientIp(req);
  const ua = (req.headers.get("user-agent") ?? "").slice(0, 512);

  // ---- Re-sanitize marketing attribution at the trust boundary (PII-free) ----
  // Only the UTM/referrer/landing_page allowlist survives; email/consent/unknown
  // keys are dropped by buildAttributionPayload before anything is persisted.
  const attribution = buildAttributionPayload({
    anonymous_id:    body?.anonymous_id,
    attribution_key: body?.attribution_key,
    landing_page:    body?.landing_page,
    first_touch:     body?.first_touch,
    last_touch:      body?.last_touch,
  });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // ---- Best-effort rate-limit per IP ----
  if (ip) {
    const { count } = await admin
      .from("trial_intents")
      .select("token", { count: "exact", head: true })
      .eq("consent_ip", ip)
      .gte("created_at", new Date(Date.now() - 60 * 60 * 1000).toISOString());
    if ((count ?? 0) >= 5) {
      return json({ ok: false, error: "rate_limited" }, 429);
    }
  }

  // ---- Generate token + insert ----
  let token = "";
  let inserted = false;
  for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
    token = genToken();
    const expiresAt = new Date(Date.now() + TTL_MIN * 60 * 1000).toISOString();
    const { error } = await admin.from("trial_intents").insert({
      token,
      email,
      lang,
      source,
      intent_type: intentType,
      consent_ip: ip,
      consent_user_agent: ua,
      consent_locale: lang,
      expires_at: expiresAt,
      // ATTRIBUTION add-on — additive columns (see migration 026).
      anonymous_id:    attribution.anonymous_id,
      attribution_key: attribution.attribution_key,
      first_touch:     attribution.first_touch,
      last_touch:      attribution.last_touch,
      landing_page:    attribution.landing_page,
    });
    if (!error) { inserted = true; break; }
    if (error.code !== "23505") { // not a uniqueness collision -> real error
      console.error("trial_intents insert failed:", error);
      return json({ ok: false, error: "db_error", detail: error.message }, 500);
    }
  }
  if (!inserted) {
    return json({ ok: false, error: "token_collision" }, 500);
  }

  // ATTRIBUTION add-on — idempotent 'signup' conversion event. Best-effort:
  // the trial intent already committed above, so an attribution failure must
  // NOT fail the request.
  try {
    const { error: attrErr } = await admin.rpc("record_signup_attribution", {
      p_token: token,
      p_anonymous_id: attribution.anonymous_id,
      p_attribution_key: attribution.attribution_key,
      p_first_touch: attribution.first_touch,
      p_last_touch: attribution.last_touch,
      p_landing_page: attribution.landing_page,
      p_profile_id: null,
    });
    if (attrErr) console.warn("record_signup_attribution failed:", attrErr.message);
  } catch (e) {
    console.warn("record_signup_attribution threw:", (e as Error).message);
  }

  const deepLink = `https://t.me/${BOT_USERNAME}?start=trial_t_${token}`;

  return json({
    ok: true,
    token,
    deep_link: deepLink,
    expires_in_seconds: TTL_MIN * 60,
    lang,
    intent_type: intentType,
  });
});

// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: trial-intent-create
//
// Called by the public web trial/signup forms (ru/trial.html, members.html
// signup). Records a one-shot trial intent bound to an email + consent, stores
// the sanitized marketing attribution, writes the 'signup' conversion event,
// and returns a Telegram deep link the browser redirects to.
//
// !!! RECONCILE WITH THE DEPLOYED SOURCE BEFORE DEPLOY !!!
// A trial-intent-create function is already live but was never versioned in
// this repo. This is a faithful re-authoring. The genuinely NEW behavior is:
//   • persisting anonymous_id / attribution_key / first_touch / last_touch /
//     landing_page onto the intent, and
//   • the record_signup_attribution RPC call.
// If the live function has extra behavior (rate limiting, notifications), port
// this file's attribution block into it rather than replacing it wholesale.
//
// SECURITY:
//   • CORS is locked to the production web origins (no wildcard) via _shared.
//   • All attribution fields are re-sanitized server-side; email / consent are
//     NEVER written into conversion_attribution (PII-free by construction).
//   • Neither the token nor the email is logged.
//
// REQUIRED SECRETS: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_USERNAME
//
// REQUEST (POST application/json):
//   { email, lang, source, intent_type, accept_privacy, accept_terms,
//     anonymous_id, attribution_key, first_touch, last_touch, landing_page,
//     utm_source?, ... (legacy flat UTM, ignored for storage) }
//
// RESPONSE 200: { ok: true, deep_link, expires_in_seconds }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildAttributionPayload,
  corsHeaders,
  sanitizeString,
} from "../_shared/attribution.ts";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_USERNAME     = Deno.env.get("TELEGRAM_BOT_USERNAME") ?? "BelfedBot";

const TTL_SECONDS = 15 * 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function randomToken(bytes = 18): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")    return new Response("Method Not Allowed", { status: 405, headers: cors });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const email = sanitizeString(body?.email, 254).toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return json({ ok: false, error: "invalid_email" }, 400);
  }

  const acceptPrivacy = body?.accept_privacy === true;
  const acceptTerms   = body?.accept_terms === true;
  if (!acceptPrivacy || !acceptTerms) {
    return json({ ok: false, error: "consent_required" }, 400);
  }

  const langRaw = sanitizeString(body?.lang, 8).toLowerCase();
  const lang = langRaw === "en" ? "en" : "ru";
  const source = (sanitizeString(body?.source, 64).replace(/[^a-zA-Z0-9_]/g, "")) || "web_signup";
  const intentType = sanitizeString(body?.intent_type, 32) || "trial";

  // Re-sanitize the attribution payload at the trust boundary (PII-free).
  const attribution = buildAttributionPayload({
    anonymous_id:    body?.anonymous_id,
    attribution_key: body?.attribution_key,
    landing_page:    body?.landing_page,
    first_touch:     body?.first_touch,
    last_touch:      body?.last_touch,
  });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const token = randomToken();
  const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000).toISOString();

  const { error: insErr } = await admin.from("trial_intents").insert({
    token,
    email,
    lang,
    source,
    intent_type: intentType,
    expires_at: expiresAt,
    anonymous_id: attribution.anonymous_id,
    attribution_key: attribution.attribution_key,
    first_touch: attribution.first_touch,
    last_touch: attribution.last_touch,
    landing_page: attribution.landing_page,
  });
  if (insErr) {
    // Do not leak the token/email; log only the DB message.
    console.error("trial_intents insert failed:", insErr.message);
    return json({ ok: false, error: "db_error" }, 500);
  }

  // Signup conversion event (idempotent by 'trial-intent:<token>').
  const { error: attrErr } = await admin.rpc("record_signup_attribution", {
    p_token: token,
    p_anonymous_id: attribution.anonymous_id,
    p_attribution_key: attribution.attribution_key,
    p_first_touch: attribution.first_touch,
    p_last_touch: attribution.last_touch,
    p_landing_page: attribution.landing_page,
    p_profile_id: null,
  });
  if (attrErr) {
    // Attribution is best-effort; the trial intent itself already succeeded.
    console.warn("record_signup_attribution failed:", attrErr.message);
  }

  return json({
    ok: true,
    deep_link: `https://t.me/${BOT_USERNAME}?start=trial_t_${token}`,
    expires_in_seconds: TTL_SECONDS,
  });
});

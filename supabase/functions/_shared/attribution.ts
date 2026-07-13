// ===========================================
// BelFed Attribution — server-side sanitizer
// ===========================================
// Server mirror of the browser sanitizer in /belfed-attribution.js. Every field
// that arrives from an untrusted client is RE-VALIDATED here before it is
// persisted, so a tampered browser payload cannot inject control chars, PII, or
// oversized values into trial_intents / conversion_funnel_events.
//
// Design rules (kept in lock-step with /belfed-attribution.js):
//   • Only these marketing fields are ever kept on a touch:
//       utm_source, utm_medium, utm_campaign, utm_content, utm_term,
//       referrer, landing_page, captured_at
//   • NO PII (email / telegram / name) is ever stored in an attribution touch
//     or in conversion_funnel_events.metadata.
//   • Every string is trimmed, stripped of control chars and length-capped.

export const UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;

const MAX_FIELD = 200; // per utm field
const MAX_URL = 512; // referrer / landing_page

export interface Touch {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  referrer?: string;
  landing_page?: string;
  captured_at?: string;
}

export interface AttributionPayload {
  anonymous_id: string | null;
  attribution_key: string;
  landing_page: string | null;
  first_touch: Touch | null;
  last_touch: Touch | null;
}

export function uuid(): string {
  return crypto.randomUUID();
}

// Coerce to a clean, length-capped single-line string. Returns '' when the
// input is not a usable scalar.
export function sanitizeString(v: unknown, max = MAX_FIELD): string {
  if (v == null) return "";
  let s: string;
  if (typeof v === "string") s = v;
  else if (typeof v === "number" || typeof v === "boolean") s = String(v);
  else return "";
  // Strip ASCII + Unicode control chars, collapse whitespace, trim, cap.
  s = s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  if (s.length > max) s = s.slice(0, max);
  return s;
}

// Reduce a URL/referrer to origin+path only (drop query + hash) so we never
// persist arbitrary query params that could carry PII.
export function sanitizeUrl(v: unknown): string {
  const s = sanitizeString(v, MAX_URL * 2);
  if (!s) return "";
  try {
    const u = new URL(s);
    return sanitizeString(u.origin + u.pathname, MAX_URL);
  } catch {
    return sanitizeString(s.split("?")[0].split("#")[0], MAX_URL);
  }
}

// Keep only a pathname (+ leading slash). Used for landing_page.
export function sanitizeLandingPage(v: unknown): string {
  const s = sanitizeString(v, MAX_URL * 2);
  if (!s) return "";
  try {
    const u = new URL(s);
    return sanitizeString(u.pathname || "/", MAX_URL);
  } catch {
    return sanitizeString(s.split("?")[0].split("#")[0], MAX_URL);
  }
}

// Validate an ISO-8601-ish timestamp; return '' if not a real date.
export function sanitizeTimestamp(v: unknown): string {
  const s = sanitizeString(v, 40);
  if (!s) return "";
  const t = Date.parse(s);
  if (isNaN(t)) return "";
  return new Date(t).toISOString();
}

// Build a sanitized "touch" object from loose input, keeping only allowlisted
// keys. Unknown keys (incl. anything PII-shaped) are dropped. Returns null when
// nothing usable survives.
export function sanitizeTouch(raw: unknown): Touch | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: Touch = {};
  for (const k of UTM_KEYS) {
    const val = sanitizeString(r[k], MAX_FIELD);
    if (val) (out as Record<string, string>)[k] = val;
  }
  const ref = sanitizeUrl(r.referrer);
  if (ref) out.referrer = ref;
  const lp = sanitizeLandingPage(r.landing_page);
  if (lp) out.landing_page = lp;
  const ts = sanitizeTimestamp(r.captured_at);
  if (ts) out.captured_at = ts;
  return Object.keys(out).length ? out : null;
}

// Assemble the full, sanitized attribution payload persisted alongside a
// trial_intent. `anonymous_id` is a pseudonymous UUID (no PII).
export function buildAttributionPayload(
  opts: {
    anonymous_id?: unknown;
    attribution_key?: unknown;
    landing_page?: unknown;
    first_touch?: unknown;
    last_touch?: unknown;
  } = {},
): AttributionPayload {
  const anon = sanitizeString(opts.anonymous_id, 64);
  return {
    anonymous_id: /^[0-9a-fA-F-]{16,64}$/.test(anon) ? anon : null,
    attribution_key: sanitizeString(opts.attribution_key, 64) || uuid(),
    landing_page: sanitizeLandingPage(opts.landing_page) || null,
    first_touch: sanitizeTouch(opts.first_touch),
    last_touch: sanitizeTouch(opts.last_touch),
  };
}

// Canonical conversion_funnel_events.event_key builders — mirror the SQL helpers
// in the migration so both sides agree on idempotency keys.
export function signupEventKey(token: string): string {
  return "trial-intent:" + sanitizeString(token, 128);
}
export function trialEventKey(token: string): string {
  return "trial-claim:" + sanitizeString(token, 128);
}
export function paymentEventKey(provider: string, paymentId: string): string {
  return sanitizeString(provider, 32) + ":" + sanitizeString(paymentId, 200);
}

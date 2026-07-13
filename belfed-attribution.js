// ===========================================
// BelFed Attribution — shared, PII-free sanitizer
// ===========================================
// Single source of truth for the attribution payload sent to the
// `trial-intent-create` edge function. Loaded in the browser BEFORE
// belfed-analytics.js, and require()-d by the Node test suite.
//
// Design rules (see supabase/functions/_shared/attribution.ts for the
// server-side mirror that re-validates everything):
//   • Only these marketing fields ever leave the browser:
//       utm_source, utm_medium, utm_campaign, utm_content, utm_term,
//       referrer, landing_page, captured_at
//   • NO PII (email / telegram / name) is ever placed in an attribution
//     touch or in conversion_attribution.metadata.
//   • Every string is trimmed, stripped of control chars and length-capped.
//   • anonymous_id is a random UUID persisted in localStorage — it carries
//     no personal data, only a stable pseudonymous handle.
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node
  if (root) root.BelfedAttribution = api;                                    // browser
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null), function () {
  'use strict';

  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  var MAX_FIELD = 200;   // per utm field
  var MAX_URL = 512;     // referrer / landing_page
  var ANON_KEY = 'bf_anon_id';

  function uuid() {
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
      if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        var b = crypto.getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
        var h = Array.from(b).map(function (x) { return x.toString(16).padStart(2, '0'); });
        return h[0]+h[1]+h[2]+h[3]+'-'+h[4]+h[5]+'-'+h[6]+h[7]+'-'+h[8]+h[9]+'-'+h[10]+h[11]+h[12]+h[13]+h[14]+h[15];
      }
    } catch (e) {}
    // Non-crypto fallback (should never hit in supported browsers).
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0, v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // Coerce to a clean, length-capped single-line string. Returns '' when the
  // input is not a usable scalar.
  function sanitizeString(v, max) {
    if (v == null) return '';
    if (typeof v !== 'string') {
      if (typeof v === 'number' || typeof v === 'boolean') v = String(v);
      else return '';
    }
    // Strip ASCII + Unicode control chars, collapse whitespace, trim, cap.
    var s = v.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (s.length > (max || MAX_FIELD)) s = s.slice(0, max || MAX_FIELD);
    return s;
  }

  // Reduce a URL/referrer to origin+path only (drop query + hash) so we never
  // persist arbitrary query params that could carry PII. Falls back to a plain
  // capped string when the value is not a parseable URL.
  function sanitizeUrl(v) {
    var s = sanitizeString(v, MAX_URL * 2);
    if (!s) return '';
    try {
      var u = new URL(s);
      return sanitizeString(u.origin + u.pathname, MAX_URL);
    } catch (e) {
      // Relative path or opaque value: keep path portion before any '?'/'#'.
      return sanitizeString(s.split('?')[0].split('#')[0], MAX_URL);
    }
  }

  // Keep only a pathname (+ leading slash). Used for landing_page so a bare
  // path like "/ru/trial.html" stays intact but full URLs are reduced.
  function sanitizeLandingPage(v) {
    var s = sanitizeString(v, MAX_URL * 2);
    if (!s) return '';
    try {
      var u = new URL(s);
      return sanitizeString(u.pathname || '/', MAX_URL);
    } catch (e) {
      return sanitizeString(s.split('?')[0].split('#')[0], MAX_URL);
    }
  }

  // Validate an ISO-8601-ish timestamp; return '' if not a real date.
  function sanitizeTimestamp(v) {
    var s = sanitizeString(v, 40);
    if (!s) return '';
    var t = Date.parse(s);
    if (isNaN(t)) return '';
    return new Date(t).toISOString();
  }

  // Build a sanitized "touch" object from a loose input, keeping only the
  // allowlisted keys. Unknown keys (incl. anything PII-shaped) are dropped.
  function sanitizeTouch(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var out = {};
    UTM_KEYS.forEach(function (k) {
      var val = sanitizeString(raw[k], MAX_FIELD);
      if (val) out[k] = val;
    });
    var ref = sanitizeUrl(raw.referrer);
    if (ref) out.referrer = ref;
    var lp = sanitizeLandingPage(raw.landing_page);
    if (lp) out.landing_page = lp;
    var ts = sanitizeTimestamp(raw.captured_at);
    if (ts) out.captured_at = ts;
    return Object.keys(out).length ? out : null;
  }

  // Read (or lazily create) the stable pseudonymous anonymous_id.
  function getAnonymousId(storage) {
    try {
      var s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
      if (!s) return uuid();
      var v = s.getItem(ANON_KEY);
      if (v && /^[0-9a-fA-F-]{16,64}$/.test(v)) return v;
      v = uuid();
      s.setItem(ANON_KEY, v);
      return v;
    } catch (e) {
      return uuid();
    }
  }

  // Assemble the full, sanitized payload the trial pages POST to
  // trial-intent-create. `first`/`last` are loose touch inputs.
  function buildAttributionPayload(opts) {
    opts = opts || {};
    var payload = {
      anonymous_id: sanitizeString(opts.anonymous_id, 64) || null,
      attribution_key: sanitizeString(opts.attribution_key, 64) || uuid(),
      landing_page: sanitizeLandingPage(opts.landing_page) || null,
      first_touch: sanitizeTouch(opts.first_touch),
      last_touch: sanitizeTouch(opts.last_touch),
    };
    return payload;
  }

  // Canonical conversion_attribution.event_key builders. Mirrors the SQL in
  // the migration so tests can assert both sides agree.
  function signupEventKey(token) { return 'trial-intent:' + sanitizeString(token, 128); }
  function trialEventKey(token) { return 'trial-claim:' + sanitizeString(token, 128); }
  function paymentEventKey(provider, paymentId) {
    return sanitizeString(provider, 32) + ':' + sanitizeString(paymentId, 200);
  }

  return {
    UTM_KEYS: UTM_KEYS,
    uuid: uuid,
    sanitizeString: sanitizeString,
    sanitizeUrl: sanitizeUrl,
    sanitizeLandingPage: sanitizeLandingPage,
    sanitizeTimestamp: sanitizeTimestamp,
    sanitizeTouch: sanitizeTouch,
    getAnonymousId: getAnonymousId,
    buildAttributionPayload: buildAttributionPayload,
    signupEventKey: signupEventKey,
    trialEventKey: trialEventKey,
    paymentEventKey: paymentEventKey,
  };
});

// ===========================================
// BelFed Analytics — lightweight UTM + event layer
// ===========================================
// No external dependencies. Safe to include on any page.
// - Persists first-touch and last-touch UTM params in localStorage.
// - Propagates UTM params onto internal funnel links (esp. /members.html).
// - belfedTrack(name, props) records funnel events. With no backend wired,
//   events are buffered on window.belfedEvents, mirrored to window.dataLayer,
//   and logged to the console in debug mode (?debug=1 or localStorage bf_debug=1).
//
// Canonical event names:
//   landing_view, cta_click, signup_complete, trial_started,
//   telegram_connected, payment_started, subscription_paid, trial_expired
(function (w, d) {
  'use strict';
  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  var FIRST_KEY = 'bf_utm_first';
  var LAST_KEY = 'bf_utm_last';

  function safeParse(json) { try { return JSON.parse(json) || {}; } catch (e) { return {}; } }
  function lsGet(k) { try { return w.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { w.localStorage.setItem(k, v); } catch (e) {} }

  function isDebug() {
    try {
      if (/[?&]debug=1\b/.test(w.location.search)) { lsSet('bf_debug', '1'); return true; }
      return lsGet('bf_debug') === '1';
    } catch (e) { return false; }
  }

  // Read UTM params present in the current URL.
  function currentUTM() {
    var out = {};
    try {
      var p = new URLSearchParams(w.location.search);
      UTM_KEYS.forEach(function (k) { var v = p.get(k); if (v) out[k] = v; });
    } catch (e) {}
    return out;
  }

  // Capture first-touch (set once) and last-touch (updated when new UTMs arrive).
  function captureUTM() {
    var cur = currentUTM();
    var hasCur = Object.keys(cur).length > 0;
    if (hasCur) {
      if (!lsGet(FIRST_KEY)) {
        cur._ts = new Date().toISOString();
        if (d.referrer) cur._referrer = d.referrer;
        lsSet(FIRST_KEY, JSON.stringify(cur));
      }
      lsSet(LAST_KEY, JSON.stringify(cur));
    }
  }

  // Best-available UTM set: current URL → last-touch → first-touch.
  function effectiveUTM() {
    var cur = currentUTM();
    if (Object.keys(cur).length) return cur;
    var last = safeParse(lsGet(LAST_KEY));
    if (Object.keys(last).length) return last;
    return safeParse(lsGet(FIRST_KEY));
  }

  // UTM fields ready to merge into a payload (first + last touch).
  function utmPayload() {
    var first = safeParse(lsGet(FIRST_KEY));
    var last = safeParse(lsGet(LAST_KEY));
    var eff = effectiveUTM();
    var out = {};
    UTM_KEYS.forEach(function (k) {
      if (eff[k]) out[k] = eff[k];
      if (first[k]) out['first_' + k] = first[k];
    });
    if (first._referrer) out.referrer = first._referrer;
    return out;
  }

  // Append effective UTM params to internal funnel links (without clobbering existing ones).
  function propagateUTM(root) {
    var utm = effectiveUTM();
    if (!Object.keys(utm).length) return;
    var links = (root || d).querySelectorAll('a[href]');
    Array.prototype.forEach.call(links, function (a) {
      var href = a.getAttribute('href') || '';
      // Only same-site funnel links (relative, root-relative, or belfed.ru).
      var isInternal = /^\//.test(href) || /^https?:\/\/(www\.)?belfed\.ru/.test(href) || href.indexOf('members.html') !== -1;
      var isExternalDomain = /^https?:\/\//.test(href) && !/belfed\.ru/.test(href);
      if (!isInternal || isExternalDomain) return;
      try {
        var url = new URL(href, w.location.origin);
        UTM_KEYS.forEach(function (k) { if (utm[k] && !url.searchParams.get(k)) url.searchParams.set(k, utm[k]); });
        // Preserve hash (e.g. #signup) — URL handles it.
        a.setAttribute('href', url.pathname + url.search + url.hash);
      } catch (e) {}
    });
  }

  // Record a funnel event.
  function track(name, props) {
    var evt = { event: name, ts: new Date().toISOString() };
    var utm = effectiveUTM();
    Object.keys(utm).forEach(function (k) { evt[k] = utm[k]; });
    if (props) Object.keys(props).forEach(function (k) { evt[k] = props[k]; });
    w.belfedEvents = w.belfedEvents || [];
    w.belfedEvents.push(evt);
    w.dataLayer = w.dataLayer || [];
    w.dataLayer.push(evt);
    if (isDebug()) { try { console.log('[belfed:event]', name, evt); } catch (e) {} }
    return evt;
  }

  // Delegate cta_click on elements opting in via [data-bf-cta] or links to the signup/pricing funnel.
  function wireCtaClicks() {
    d.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('a,button') : null;
      if (!el) return;
      var explicit = el.getAttribute('data-bf-cta');
      var href = el.getAttribute('href') || '';
      var isFunnel = href.indexOf('members.html') !== -1 || href.indexOf('#pricing') !== -1 || href.indexOf('trial.html') !== -1;
      if (explicit || isFunnel) {
        track('cta_click', {
          cta: explicit || (el.textContent || '').trim().slice(0, 60),
          href: href || null
        });
      }
    }, true);
  }

  function init() {
    captureUTM();
    propagateUTM(d);
    wireCtaClicks();
  }

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', init);
  else init();

  // Public API
  w.belfedAnalytics = {
    track: track,
    utm: effectiveUTM,
    utmPayload: utmPayload,
    propagateUTM: propagateUTM,
    isDebug: isDebug
  };
  // Convenience global used across pages.
  w.belfedTrack = track;
})(window, document);

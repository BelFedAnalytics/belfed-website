// belfed-payments.js
// Checkout entry-point for BelFed Analytics members area.
//
// 2026-07-03: BelFed migrated fully off YooKassa. All checkout is now handled
// externally via Tribute. This module exposes a single startCheckout() call
// that opens the correct Tribute URL for the user's locale, preferring the
// Telegram in-app deeplink when the user is already inside Telegram and
// falling back to the Tribute Web checkout otherwise.
//
// Loaded after belfed-auth.js. Exposes window.BelfedPayments.
(function () {
  'use strict';

  // Tribute checkout endpoints, per locale.
  // RU: 1500 RUB / month. EN: $15 / month.
  var TRIBUTE_URLS = {
    ru: {
      tg:  'https://t.me/tribute/app?startapp=sZH9',
      web: 'https://web.tribute.tg/s/ZH9'
    },
    en: {
      tg:  'https://t.me/tribute/app?startapp=sZH2',
      web: 'https://web.tribute.tg/s/ZH2'
    }
  };

  function detectLocale(explicit) {
    if (explicit === 'ru' || explicit === 'en') return explicit;
    try {
      // Prefer the user's profile language if belfed-auth exposes it.
      if (window.belfedProfile && window.belfedProfile.lang) {
        var l = String(window.belfedProfile.lang).toLowerCase();
        if (l === 'ru' || l === 'en') return l;
      }
    } catch (_) {}
    try {
      var htmlLang = (document.documentElement.getAttribute('lang') || '').toLowerCase();
      if (htmlLang.indexOf('ru') === 0) return 'ru';
      if (htmlLang.indexOf('en') === 0) return 'en';
    } catch (_) {}
    try {
      var nav = (navigator.language || '').toLowerCase();
      if (nav.indexOf('ru') === 0) return 'ru';
    } catch (_) {}
    // Default to RU — BelFed's primary audience.
    return 'ru';
  }

  function isTelegramInApp() {
    try {
      if (window.Telegram && window.Telegram.WebApp) return true;
      return /Telegram/i.test(navigator.userAgent || '');
    } catch (_) {
      return false;
    }
  }

  function resolveCheckoutUrl(opts) {
    opts = opts || {};
    var locale = detectLocale(opts.locale);
    var urls = TRIBUTE_URLS[locale] || TRIBUTE_URLS.ru;
    return isTelegramInApp() ? urls.tg : urls.web;
  }

  function startCheckout(opts) {
    opts = opts || {};
    try {
      if (typeof window !== 'undefined' && window.belfedTrack) {
        window.belfedTrack('payment_started', {
          plan: opts.plan || 'month',
          provider: 'tribute',
          locale: detectLocale(opts.locale)
        });
      }
    } catch (_) {}
    var url = resolveCheckoutUrl(opts);
    // Open in a new tab so the member portal remains available for the user
    // to return to after paying in Tribute. Fall back to same-window navigation
    // if the popup is blocked.
    var win = null;
    try { win = window.open(url, '_blank', 'noopener'); } catch (_) {}
    if (!win) window.location.assign(url);
    return Promise.resolve({ provider: 'tribute', url: url });
  }

  function bindButton(selector, opts) {
    var btn = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!btn) return;
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      startCheckout(opts).catch(function (err) {
        console.error('[BelfedPayments] checkout failed', err);
      });
    });
  }

  function handleReturn() {
    try {
      var url = new URL(window.location.href);
      if (url.searchParams.get('payment') === 'success' ||
          url.searchParams.get('payment') === 'return') {
        if (typeof window.belfedRefreshProfile === 'function') {
          window.belfedRefreshProfile();
        }
      }
    } catch (_) {}
  }

  document.addEventListener('DOMContentLoaded', handleReturn);

  // Global delegated click handler: any element with `data-belfed-checkout`
  // opens Tribute directly. The attribute value is treated as the plan
  // (defaults to 'month'). This lets HTML pages wire checkout without JS.
  document.addEventListener('click', function (e) {
    var target = e.target;
    while (target && target !== document) {
      if (target.nodeType === 1 && target.hasAttribute && target.hasAttribute('data-belfed-checkout')) {
        e.preventDefault();
        var plan = target.getAttribute('data-belfed-checkout') || 'month';
        var locale = target.getAttribute('data-belfed-locale') || undefined;
        startCheckout({ plan: plan, locale: locale }).catch(function (err) {
          console.error('[BelfedPayments] checkout failed', err);
        });
        return;
      }
      target = target.parentNode;
    }
  }, false);

  window.BelfedPayments = {
    startCheckout: startCheckout,
    bindButton: bindButton,
    resolveCheckoutUrl: resolveCheckoutUrl,
    // Legacy shim: some call-sites still call createPayment().
    // Redirects to Tribute instead of returning a confirmation_url.
    createPayment: function (opts) { return startCheckout(opts); }
  };
})();

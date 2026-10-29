/* Shared public navigation — mirrors the landing page (index.html) header across all user-facing pages. */
(function () {
  'use strict';
  var siteLanguage = document.currentScript && document.currentScript.dataset.lang;

  function ensureCourierPrime() {
    if (document.querySelector('link[href*="Courier+Prime"]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Courier+Prime:wght@400;700&display=swap';
    document.head.appendChild(link);
  }

  function mount() {
    if (document.getElementById('bf-site-header')) return;
    ensureCourierPrime();

    try {
      var savedTheme = localStorage.getItem('belfed-theme');
      if (savedTheme === 'dark' || savedTheme === 'light') {
        document.documentElement.setAttribute('data-theme', savedTheme);
      }
    } catch (e) {}

    var ru = siteLanguage
      ? siteLanguage === 'ru'
      : location.hostname === 'belfed.ru' || (location.hostname !== 'belfed.com' && document.documentElement.lang !== 'en');

    var t = ru
      ? {
          tour: 'Что вы получаете',
          how: 'Как это работает',
          trades: 'История сделок ↗',
          research: 'Исследования',
          learn: 'Обучение',
          beta: 'бета',
          learnAria: 'Обучение, бета',
          pricing: 'Тарифы',
          faq: 'FAQ',
          login: 'Войти',
          free: 'Бесплатный доступ',
          menu: 'Меню',
          nav: 'Основная навигация',
          langGroup: 'Язык',
          language: 'Switch to English',
          theme: 'Переключить тему'
        }
      : {
          tour: 'What you get',
          how: 'How it works',
          trades: 'Track record ↗',
          research: 'Research',
          learn: 'Learn',
          beta: 'beta',
          learnAria: 'Learn, beta',
          pricing: 'Pricing',
          faq: 'FAQ',
          login: 'Login',
          free: 'Start free access',
          menu: 'Menu',
          nav: 'Primary',
          langGroup: 'Language',
          language: 'Переключить на русский',
          theme: 'Toggle theme'
        };

    var current = location.pathname.replace(/index\.html$/, '');
    var tourHref = '/#tour';
    var howHref = '/#how';
    var pricingHref = '/#pricing';
    var faqHref = '/#faq';
    var tradesHref = ru ? '/ru/trades.html' : '/trades.html';

    var items = [
      { href: tourHref, label: t.tour, spy: 'tour' },
      { href: howHref, label: t.how, spy: 'how' },
      { href: tradesHref, label: t.trades, key: 'trades' },
      { href: '/research/', label: t.research, key: 'research' },
      { href: '/learn/', label: t.learn, beta: t.beta, ariaLabel: t.learnAria, key: 'learn' },
      { href: pricingHref, label: t.pricing, spy: 'pricing' },
      { href: faqHref, label: t.faq, spy: 'faq' }
    ];

    function active(item) {
      if (item.key === 'research') return current.indexOf('/research/') === 0;
      if (item.key === 'learn') return current.indexOf('/learn/') === 0;
      if (item.key === 'trades') return /(?:trades|equities|results)\.html$/.test(location.pathname);
      return false;
    }

    var otherOrigin = ru ? 'https://belfed.com' : 'https://belfed.ru';
    var otherPath = location.pathname.replace(/^\/(?:ru|en)\//, '/');
    if (/\/(?:equities|equities-trades)\.html$/.test(location.pathname)) {
      otherPath = ru ? '/equities-trades.html' : '/ru/equities.html';
    } else if (/\/trades\.html$/.test(location.pathname)) {
      otherPath = ru ? '/trades.html' : '/ru/trades.html';
    } else if (/\/(?:about|products|privacy|disclaimer|oferta|contacts|trial)\.html$/.test(location.pathname)) {
      var file = otherPath.split('/').pop();
      if (file === 'contacts.html' || file === 'trial.html') otherPath = '/';
      else if (file === 'oferta.html') otherPath = '/terms.html';
      else if (file === 'terms.html' && !ru) otherPath = '/ru/oferta.html';
      else if (!ru) otherPath = '/ru/' + file;
    } else if (current.indexOf('/learn/') === 0) {
      var learningPaths = {
        '/learn/sving-treyding.html': '/learn/what-is-swing-trading.html',
        '/learn/what-is-swing-trading.html': '/learn/sving-treyding.html',
        '/learn/r-multiplikator.html': '/learn/r-multiple-explained.html',
        '/learn/r-multiple-explained.html': '/learn/r-multiplikator.html'
      };
      otherPath = learningPaths[current] || '/learn/';
    }
    var alternate = document.querySelector('link[hreflang="' + (ru ? 'en' : 'ru') + '"]');
    var other = alternate ? alternate.href : otherOrigin + otherPath;
    if (/\/research\/|\/learn\/|(?:trades|equities)\.html$/.test(current)) other += location.hash;

    // Preserve old DOM for page scripts, but hide duplicate global navigation.
    document.querySelectorAll('body > nav:not(.sub-nav):not(.admin-nav), body > .menu-drop, body > #menuDrop').forEach(function (el) {
      el.setAttribute('data-bf-legacy-nav', '');
      el.setAttribute('aria-hidden', 'true');
      el.inert = true;
    });

    var style = document.createElement('style');
    style.textContent = `
      html[data-theme="dark"] {
        --white: #0d0d0a;
        --paper: #131310;
        --paper-2: #1a1a16;
        --light-gray: #131310;
        --rule: #ffffff14;
        --rule-strong: #ffffff26;
        --border: #2a2a24;
        --black: #f1f1ea;
        --ink: #e5e5dc;
        --ink-2: #c9c9bf;
        --gray: #8a8a82;
        --gray-soft: #a3a39a;
        --gray-faint: #4a4a44;
        --green: #2fa05a;
        --green-soft: #2fa05a1f;
        --green-strong: #46c277;
        --red: #d65a5a;
        --gold: #d6a020;
      }
      [data-bf-legacy-nav] { display: none !important; }
      #memberLock { top: 65px !important; }
      @keyframes bf-blink { 50% { opacity: 0; } }
      #bf-site-header, #bf-site-header * { box-sizing: border-box; }
      #bf-site-header {
        --bf-mono: 'Courier Prime', 'Courier New', ui-monospace, monospace;
        --bf-white: #f5f5f0;
        --bf-paper: #efefe7;
        --bf-paper-2: #e7e7dd;
        --bf-rule: rgba(26, 26, 26, 0.08);
        --bf-rule-strong: rgba(26, 26, 26, 0.15);
        --bf-black: #0a0a0a;
        --bf-ink: #161614;
        --bf-gray-soft: #6b6b6b;
        --bf-green: #1a6b3a;
        --bf-green-soft: rgba(26, 107, 58, 0.08);
        --bf-green-strong: #14542d;
        --bf-t: 200ms cubic-bezier(.2, .7, .2, 1);
        visibility: visible;
        position: sticky;
        top: 0;
        z-index: 1000;
        width: calc(100% + var(--bf-pad-left, 0px) + var(--bf-pad-right, 0px));
        margin: calc(-1 * var(--bf-pad-top, 0px)) calc(-1 * var(--bf-pad-right, 0px)) 0 calc(-1 * var(--bf-pad-left, 0px));
        padding: 0;
        background: color-mix(in oklab, var(--bf-white) 88%, transparent);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        border-bottom: 1px solid var(--bf-rule);
        font-family: var(--bf-mono);
        color: var(--bf-ink);
        line-height: 1.5;
        letter-spacing: normal;
        text-align: left;
        isolation: isolate;
      }
      html[data-theme="dark"] #bf-site-header {
        --bf-white: #0d0d0a;
        --bf-paper: #131310;
        --bf-paper-2: #1a1a16;
        --bf-rule: rgba(255, 255, 255, 0.08);
        --bf-rule-strong: rgba(255, 255, 255, 0.15);
        --bf-black: #f1f1ea;
        --bf-ink: #e5e5dc;
        --bf-gray-soft: #a3a39a;
        --bf-green: #2fa05a;
        --bf-green-soft: rgba(47, 160, 90, 0.12);
        --bf-green-strong: #46c277;
      }
      #bf-site-header .bf-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 28px;
        gap: 20px;
      }
      #bf-site-header a {
        text-decoration: none;
        color: inherit;
        white-space: nowrap;
      }
      #bf-site-header .bf-logo {
        font-family: var(--bf-mono);
        font-weight: 700;
        font-size: 17px;
        letter-spacing: 0.22em;
        color: var(--bf-black);
        white-space: nowrap;
        flex-shrink: 0;
      }
      #bf-site-header .bf-cursor {
        display: inline-block;
        animation: bf-blink 1.2s steps(1) infinite;
        color: var(--bf-green);
        margin-left: 2px;
      }
      #bf-site-header .bf-links {
        display: flex;
        align-items: center;
        gap: 28px;
        list-style: none;
        margin: 0;
        padding: 0;
      }
      #bf-site-header .bf-links > a {
        font-family: var(--bf-mono);
        font-size: 13px;
        font-weight: 400;
        color: var(--bf-gray-soft);
        letter-spacing: 0.04em;
        transition: color var(--bf-t);
      }
      #bf-site-header .bf-links > a:hover,
      #bf-site-header .bf-links > a.active,
      #bf-site-header .bf-links > a[aria-current="page"] {
        color: var(--bf-black);
      }
      #bf-site-header .bf-links > a[aria-current="page"],
      #bf-site-header .bf-links > a.active {
        font-weight: 700;
      }
      #bf-site-header .bf-learn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      #bf-site-header .bf-beta {
        font-family: var(--bf-mono);
        font-size: 8px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--bf-green-strong);
        background: var(--bf-green-soft);
        border: 1px solid var(--bf-rule-strong);
        padding: 1px 5px;
        border-radius: 99px;
        line-height: 1.4;
        position: relative;
        top: -1px;
      }
      #bf-site-header .bf-actions {
        display: flex;
        align-items: center;
        gap: 14px;
        flex-shrink: 0;
      }
      #bf-site-header .bf-lang-globe {
        display: inline-flex;
      }
      #bf-site-header .bf-lang {
        width: 32px;
        height: 32px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        color: var(--bf-gray-soft);
        transition: color var(--bf-t), background var(--bf-t);
        font-family: var(--bf-mono);
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.04em;
        position: relative;
      }
      #bf-site-header .bf-lang:hover {
        color: var(--bf-ink);
        background: var(--bf-paper);
      }
      #bf-site-header .bf-lang-code {
        position: absolute;
        bottom: -2px;
        right: -2px;
        background: var(--bf-black);
        color: var(--bf-white);
        font-size: 8px;
        padding: 1px 4px;
        border-radius: 6px;
        letter-spacing: 0.05em;
        line-height: 1.1;
      }
      #bf-site-header .bf-theme-btn {
        width: 32px;
        height: 32px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 4px;
        color: var(--bf-gray-soft);
        background: transparent;
        border: none;
        cursor: pointer;
        transition: color var(--bf-t), background var(--bf-t);
      }
      #bf-site-header .bf-theme-btn:hover {
        color: var(--bf-black);
        background: var(--bf-paper);
      }
      #bf-site-header .bf-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        padding: 8px 14px;
        font-family: var(--bf-mono);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        border-radius: 99px;
        transition: all var(--bf-t);
        border: 1px solid transparent;
        cursor: pointer;
        line-height: 1.3;
      }
      #bf-site-header .bf-account {
        background: transparent;
        color: var(--bf-ink);
        border-color: var(--bf-rule-strong);
      }
      #bf-site-header .bf-account:hover {
        border-color: var(--bf-black);
        color: var(--bf-black);
      }
      #bf-site-header .bf-cta {
        background: var(--bf-black);
        color: var(--bf-white);
      }
      #bf-site-header .bf-links a.bf-cta {
        color: var(--bf-white);
      }
      #bf-site-header .bf-cta:hover {
        background: var(--bf-green-strong);
        color: var(--bf-white);
        transform: translateY(-1px);
        box-shadow: 0 6px 24px rgba(26, 107, 58, 0.15);
      }
      #bf-site-header .bf-toggle {
        display: none;
        width: 36px;
        height: 36px;
        align-items: center;
        justify-content: center;
        color: var(--bf-gray-soft);
        border-radius: 4px;
        background: transparent;
        border: none;
        cursor: pointer;
      }
      #bf-site-header .bf-toggle:hover {
        color: var(--bf-black);
        background: var(--bf-paper);
      }
      #bf-site-header a:focus-visible,
      #bf-site-header button:focus-visible {
        outline: 2px solid var(--bf-green);
        outline-offset: 3px;
      }
      #bf-site-header .bf-mobile-actions {
        display: none;
      }
      @media (max-width: 1380px) {
        #bf-site-header .bf-links { gap: 18px; }
      }
      @media (max-width: 1280px) {
        #bf-site-header .bf-toggle { display: inline-flex; }
        #bf-site-header .bf-links {
          display: none;
          position: absolute;
          top: 100%;
          left: 0;
          right: 0;
          background: var(--bf-white);
          border-bottom: 1px solid var(--bf-rule-strong);
          padding: 12px 28px 20px;
          max-height: calc(100dvh - 64px);
          overflow: auto;
          box-shadow: 0 12px 24px rgba(10, 10, 10, 0.08);
        }
        #bf-site-header[data-open] .bf-links {
          display: flex;
          flex-direction: column;
          align-items: stretch;
          gap: 0;
        }
        #bf-site-header .bf-links > a {
          display: flex;
          align-items: center;
          min-height: 44px;
          padding: 10px 0;
          font-size: 14px;
          border-bottom: 1px solid var(--bf-rule);
          color: var(--bf-ink);
        }
        #bf-site-header .bf-links > a:last-of-type {
          border-bottom: none;
        }
      }
      @media (max-width: 640px) {
        #memberLock { top: 57px !important; }
        #bf-site-header .bf-bar {
          padding: 12px 16px;
          gap: 8px;
        }
        #bf-site-header .bf-actions {
          gap: 6px;
        }
        #bf-site-header .bf-theme-btn {
          width: 30px;
          height: 30px;
        }
        #bf-site-header .bf-actions .bf-account,
        #bf-site-header .bf-actions .bf-cta {
          display: none;
        }
        #bf-site-header .bf-links {
          padding: 12px 18px 18px;
          max-height: calc(100dvh - 57px);
        }
        #bf-site-header .bf-mobile-actions {
          display: flex;
          gap: 10px;
          border-top: 1px solid var(--bf-rule-strong);
          margin-top: 10px;
          padding-top: 14px;
          flex-wrap: wrap;
        }
        #bf-site-header .bf-mobile-actions .bf-btn {
          flex: 1 1 auto;
          min-height: 40px;
          padding: 10px 14px;
          font-size: 11px;
        }
      }
    `;
    document.head.appendChild(style);

    var header = document.createElement('div');
    header.id = 'bf-site-header';
    header.setAttribute('role', 'banner');

    function fitBody() {
      var bodyStyle = getComputedStyle(document.body);
      header.style.setProperty('--bf-pad-left', bodyStyle.paddingLeft);
      header.style.setProperty('--bf-pad-right', bodyStyle.paddingRight);
      header.style.setProperty('--bf-pad-top', bodyStyle.paddingTop);
    }
    fitBody();
    window.addEventListener('resize', fitBody);

    var actionsHtml =
      '<a class="bf-btn bf-account nav-login" href="/members.html">' + t.login + '</a>' +
      '<a class="bf-btn bf-cta" href="' + pricingHref + '">' + t.free + '</a>';

    var linksHtml = items
      .map(function (item) {
        var isCurrent = active(item);
        var cls = item.beta ? ' class="bf-learn' + (isCurrent ? ' active' : '') + '"' : (isCurrent ? ' class="active"' : '');
        var curAttr = isCurrent ? ' aria-current="page"' : '';
        var spyAttr = item.spy ? ' data-spy="' + item.spy + '"' : '';
        var ariaAttr = item.ariaLabel ? ' aria-label="' + item.ariaLabel + '"' : '';
        var inner = item.beta
          ? item.label + '<span class="bf-beta" aria-hidden="true">' + item.beta + '</span>'
          : item.label;
        return '<a href="' + item.href + '"' + cls + curAttr + spyAttr + ariaAttr + '>' + inner + '</a>';
      })
      .join('');

    header.innerHTML =
      '<nav class="bf-bar" aria-label="' + t.nav + '">' +
        '<a class="bf-logo" href="/" aria-label="Belfed home">BELFED<span class="bf-cursor" aria-hidden="true">_</span></a>' +
        '<div class="bf-links" id="bf-primary-links" data-bf-primary>' +
          linksHtml +
          '<div class="bf-mobile-actions">' + actionsHtml + '</div>' +
        '</div>' +
        '<div class="bf-actions">' +
          '<div class="bf-lang-globe" role="group" aria-label="' + t.langGroup + '">' +
            '<a class="bf-lang" href="' + other + '" aria-label="' + t.language + '">' +
              '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/></svg>' +
              '<span class="bf-lang-code">' + (ru ? 'EN' : 'RU') + '</span>' +
            '</a>' +
          '</div>' +
          '<button class="bf-theme-btn" type="button" data-bf-theme aria-label="' + t.theme + '">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>' +
          '</button>' +
          actionsHtml +
          '<button class="bf-toggle" data-bf-toggle type="button" aria-label="' + t.menu + '" aria-expanded="false" aria-controls="bf-primary-links">' +
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>' +
          '</button>' +
        '</div>' +
      '</nav>';

    document.body.prepend(header);

    var themeBtn = header.querySelector('[data-bf-theme]');
    themeBtn.addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      var next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('belfed-theme', next); } catch (e) {}
    });

    var toggle = header.querySelector('[data-bf-toggle]');
    function close(focus) {
      header.removeAttribute('data-open');
      toggle.setAttribute('aria-expanded', 'false');
      if (focus) toggle.focus();
    }
    toggle.addEventListener('click', function () {
      var open = !header.hasAttribute('data-open');
      header.toggleAttribute('data-open', open);
      toggle.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && header.hasAttribute('data-open')) close(true);
    });
    document.addEventListener('click', function (e) {
      if (!header.contains(e.target)) close(false);
    });
    header.addEventListener('click', function (e) {
      if (e.target.closest('a')) close(false);
    });
    header.addEventListener('focusout', function (e) {
      if (e.relatedTarget && !header.contains(e.relatedTarget)) close(false);
    });
    window.matchMedia('(max-width: 1280px)').addEventListener('change', function () {
      close(false);
    });

    // Landing-page scroll-spy for #tour, #how, #pricing, #faq
    var spyLinks = header.querySelectorAll('a[data-spy]');
    var sectionMap = {};
    var hasSections = false;
    spyLinks.forEach(function (link) {
      var id = link.getAttribute('data-spy');
      var sec = document.getElementById(id);
      if (sec) {
        sectionMap[id] = { link: link, sec: sec };
        hasSections = true;
      }
    });
    if (hasSections) {
      function onScroll() {
        var y = window.scrollY + 120;
        var currentId = null;
        Object.keys(sectionMap).forEach(function (id) {
          if (y >= sectionMap[id].sec.offsetTop) currentId = id;
        });
        spyLinks.forEach(function (l) { l.classList.remove('active'); });
        if (currentId && sectionMap[currentId]) sectionMap[currentId].link.classList.add('active');
      }
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();

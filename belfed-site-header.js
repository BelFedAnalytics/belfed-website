/* Shared public navigation. Keep page-level and authenticated controls separate. */
(function () {
  'use strict';
  var siteLanguage = document.currentScript && document.currentScript.dataset.lang;
  function mount() {
    if (document.getElementById('bf-site-header')) return;
    var ru = siteLanguage ? siteLanguage === 'ru' : location.hostname === 'belfed.ru' || (location.hostname !== 'belfed.com' && document.documentElement.lang !== 'en');
    var t = ru ? {
      home: 'Главная', service: 'Сервис', research: 'Исследования', trades: 'История сделок',
      pricing: 'Тарифы', about: 'О нас', account: 'Кабинет', free: 'Начать бесплатно',
      learn: 'Обучение', menu: 'Меню', nav: 'Основная навигация', language: 'Switch to English'
    } : {
      home: 'Home', service: 'Service', research: 'Research', trades: 'Track record',
      pricing: 'Pricing', about: 'About', account: 'Members', free: 'Start free access',
      learn: 'Learn', menu: 'Menu', nav: 'Main navigation', language: 'Переключить на русский'
    };
    var items = [
      ['/', t.home], ['/#tour', t.service], ['/research/', t.research],
      [ru ? '/ru/trades.html' : '/trades.html', t.trades],
      ['/learn/', t.learn],
      ['/#pricing', t.pricing], [ru ? '/ru/about.html' : '/about.html', t.about],
      ['/#faq', 'FAQ']
    ];
    var current = location.pathname.replace(/index\.html$/, '');
    function active(href) {
      if (href.indexOf('#') !== -1) return false;
      if (href === '/') return current === '/';
      if (href === '/research/') return current.indexOf('/research/') === 0;
      if (href === '/learn/') return current.indexOf('/learn/') === 0;
      if (href.indexOf('trades') !== -1) return /(?:trades|equities)\.html$/.test(current);
      return current === href;
    }
    var otherOrigin = ru ? 'https://belfed.com' : 'https://belfed.ru';
    var otherPath = location.pathname.replace(/^\/(?:ru|en)\//, '/');
    if (/\/(?:equities|equities-trades)\.html$/.test(location.pathname)) otherPath = ru ? '/equities-trades.html' : '/ru/equities.html';
    else if (/\/trades\.html$/.test(location.pathname)) otherPath = ru ? '/trades.html' : '/ru/trades.html';
    else if (/\/(?:about|products|privacy|disclaimer|oferta|contacts|trial)\.html$/.test(location.pathname)) {
      var file = otherPath.split('/').pop();
      if (file === 'contacts.html' || file === 'trial.html') otherPath = '/';
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
    // Do not forward auth tokens, reset links or other private URL parameters.
    if (/\/research\/|\/learn\/|(?:trades|equities)\.html$/.test(current)) other += location.hash;

    // Preserve old DOM for page scripts, but remove duplicate global navigation.
    document.querySelectorAll('body > nav:not(.sub-nav):not(.admin-nav), body > .menu-drop, body > #menuDrop').forEach(function (el) {
      el.setAttribute('data-bf-legacy-nav', '');
      el.setAttribute('aria-hidden', 'true');
      el.inert = true;
    });
    var style = document.createElement('style');
    style.textContent = `
      [data-bf-legacy-nav]{display:none!important}
      #memberLock{top:77px!important}
      #bf-site-header,#bf-site-header *{box-sizing:border-box}
      #bf-site-header{visibility:visible;position:sticky;top:0;z-index:1000;width:calc(100% + var(--bf-pad-left,0px) + var(--bf-pad-right,0px));margin:calc(-1 * var(--bf-pad-top,0px)) calc(-1 * var(--bf-pad-right,0px)) 0 calc(-1 * var(--bf-pad-left,0px));padding:0;background:#f5f2eb;color:#151713;border-bottom:1px solid #d8d8cb;text-align:left;font-family:Arial,sans-serif;line-height:1.4;letter-spacing:normal;isolation:isolate}
      #bf-site-header .bf-bar{max-width:1480px;margin:auto;padding:0 32px;min-height:76px;display:flex;align-items:center;gap:28px}
      #bf-site-header a{text-decoration:none;color:inherit;letter-spacing:normal;white-space:nowrap}
      #bf-site-header .bf-logo{font-family:'Courier New',monospace;font-weight:700;font-size:24px;letter-spacing:-1px;flex-shrink:0}
      #bf-site-header .bf-logo span{color:#526441}
      #bf-site-header .bf-links{display:flex;align-items:center;justify-content:center;gap:22px;flex:1}
      #bf-site-header .bf-links a{font-size:12px;font-weight:500;padding:12px 0;position:relative;color:#4d5147}
      #bf-site-header .bf-links a:hover,#bf-site-header .bf-links a[aria-current]{color:#151713;text-decoration:underline;text-underline-offset:7px}
      #bf-site-header .bf-actions{display:flex;align-items:center;gap:10px;margin-left:auto}
      #bf-site-header .bf-account,#bf-site-header .bf-lang,#bf-site-header .bf-cta,#bf-site-header .bf-toggle{font:600 12px Arial,sans-serif;display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 14px;border:1px solid #c7cbbb;border-radius:5px;background:transparent;color:#151713;cursor:pointer}
      #bf-site-header .bf-lang{border-color:transparent;padding:0 8px}
      #bf-site-header .bf-cta{background:#526441;color:#fff;border-color:#526441}
      #bf-site-header .bf-links a.bf-cta{color:#fff}
      #bf-site-header .bf-cta:hover{background:#3f5031}
      #bf-site-header .bf-toggle{display:none}
      #bf-site-header a:focus-visible,#bf-site-header button:focus-visible{outline:2px solid #526441;outline-offset:4px}
      #bf-site-header .bf-mobile-actions{display:none}
      @media(max-width:1250px){
        #memberLock{top:69px!important}
        #bf-site-header .bf-bar{padding:0 24px;gap:16px;min-height:68px}
        #bf-site-header .bf-toggle{display:inline-flex}
        #bf-site-header .bf-links{display:none;position:absolute;top:100%;left:0;right:0;background:#f5f2eb;border-bottom:1px solid #c7cbbb;padding:16px 24px 24px;max-height:calc(100dvh - 68px);overflow:auto;box-shadow:0 12px 16px #1517130d}
        #bf-site-header[data-open] .bf-links{display:flex;flex-direction:column;align-items:stretch;gap:0}
        #bf-site-header .bf-links a{padding:13px 0;min-height:44px;font-size:15px}
      }
      @media(max-width:600px){
        #memberLock{top:65px!important}
        #bf-site-header .bf-bar{padding:0 14px;gap:8px;min-height:64px}
        #bf-site-header .bf-logo{font-size:21px}
        #bf-site-header .bf-actions{gap:3px}
        #bf-site-header .bf-actions .bf-cta,#bf-site-header .bf-actions .bf-account{display:none}
        #bf-site-header .bf-toggle{padding:0 12px}
        #bf-site-header .bf-mobile-actions{display:flex;gap:12px;border-top:1px solid #d8d8cb;margin-top:12px;padding-top:16px;flex-wrap:wrap}
        #bf-site-header .bf-mobile-actions a{padding:12px 16px;font-size:13px}
        #bf-site-header .bf-links{max-height:calc(100dvh - 64px);padding:12px 20px 20px}
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
    var actions = '<a class="bf-account" href="/members.html">' + t.account + '</a><a class="bf-cta" href="/#pricing">' + t.free + '</a>';
    header.innerHTML = '<div class="bf-bar"><a class="bf-logo" href="/" aria-label="BelFed">BELFED<span>_</span></a>' +
      '<div class="bf-links" id="bf-primary-links" data-bf-primary role="navigation" aria-label="' + t.nav + '">' +
      items.map(function (item) { return '<a href="' + item[0] + '"' + (active(item[0]) ? ' aria-current="page"' : '') + '>' + item[1] + '</a>'; }).join('') +
      '<div class="bf-mobile-actions">' + actions + '</div></div>' +
      '<div class="bf-actions"><a class="bf-lang" href="' + other + '" aria-label="' + t.language + '">' + (ru ? 'EN' : 'RU') + '</a>' +
      actions + '<button class="bf-toggle" data-bf-toggle type="button" aria-expanded="false" aria-controls="bf-primary-links">' + t.menu + ' ☰</button></div></div>';
    document.body.prepend(header);
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
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && header.hasAttribute('data-open')) close(true); });
    document.addEventListener('click', function (e) { if (!header.contains(e.target)) close(false); });
    header.addEventListener('click', function (e) { if (e.target.closest('a')) close(false); });
    header.addEventListener('focusout', function (e) { if (e.relatedTarget && !header.contains(e.relatedTarget)) close(false); });
    window.matchMedia('(max-width:1250px)').addEventListener('change', function () { close(false); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();

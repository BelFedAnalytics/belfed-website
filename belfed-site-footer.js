/* Shared RU/EN footer — mirrors the landing page (index.html) footer design across all user-facing pages. */
(function () {
  'use strict';
  var siteLanguage = document.currentScript && document.currentScript.dataset.lang;
  function mount() {
    if (document.getElementById('bf-site-footer')) return;
    var ru = siteLanguage ? siteLanguage === 'ru' : location.hostname === 'belfed.ru';
    var t = ru ? {
      description: 'Независимые глобальные инвестиционные исследования. Рыночная аналитика и торговые идеи по акциям, крипто и сырью.',
      explore: 'Продукт', community: 'Сообщество', legal: 'Юридическое',
      tour: 'Что вы получаете', how: 'Как это работает', pricing: 'Тарифы',
      trades: 'История сделок', research: 'Исследования', learn: 'Обучение',
      freeAnalysis: 'Бесплатный анализ', about: 'О нас', members: 'Войти',
      terms: 'Оферта', privacy: 'Политика конфиденциальности', disclaimer: 'Раскрытие рисков', contact: 'Контакты',
      bot: 'Telegram-бот', rights: 'Все права защищены.', payments: 'Платежи через Tribute.',
      risk: 'Раскрытие рисков: трейдинг сопряжён со значительным риском убытков. Прошлые результаты не гарантируют будущих. Ничего на этом сайте не является финансовой рекомендацией.',
      language: 'English version', top: 'Наверх', navLabel: 'Навигация в подвале сайта'
    } : {
      description: 'Independent global investment research. Market analytics and trade ideas across equities, crypto and commodities.',
      explore: 'Product', community: 'Community', legal: 'Legal',
      tour: 'What you get', how: 'How it works', pricing: 'Pricing',
      trades: 'Track record', research: 'Research', learn: 'Learn',
      freeAnalysis: 'Free analysis', about: 'About', members: 'Login',
      terms: 'Terms of service', privacy: 'Privacy policy', disclaimer: 'Risk disclaimer', contact: 'Contact',
      bot: 'Telegram bot', rights: 'All rights reserved.', payments: 'Payments by Tribute.',
      risk: 'Risk disclaimer: Trading involves substantial risk of loss. Past performance is not indicative of future results. Nothing on this site is financial advice.',
      language: 'Русская версия', top: 'Back to top', navLabel: 'Footer navigation'
    };
    var explore = [
      ['/#tour', t.tour], ['/#how', t.how], ['/#pricing', t.pricing],
      [ru ? '/ru/trades.html' : '/trades.html', t.trades], ['/research/', t.research], ['/learn/', t.learn],
      ['/#free-analysis', t.freeAnalysis], [ru ? '/ru/about.html' : '/about.html', t.about],
      ['/#faq', 'FAQ'], ['/members.html', t.members]
    ];
    var community = [
      ['https://t.me/BelFedFreeEN', 'Telegram · EN'], ['https://t.me/BelFedFreeRU', 'Telegram · RU'],
      ['https://t.me/belfedbot', t.bot], ['https://tradingview.com/u/BelFed_Analytics', 'TradingView'],
      ['https://x.com/art_the_trader', 'X / Twitter']
    ];
    var legal = [
      [ru ? '/ru/oferta.html' : '/terms.html', t.terms],
      [ru ? '/ru/privacy.html' : '/privacy.html', t.privacy],
      [ru ? '/ru/disclaimer.html' : '/disclaimer.html', t.disclaimer],
      ['mailto:hello@belfed.com', t.contact]
    ];
    function group(title, links) {
      return '<div class="bf-foot-col" data-bf-footer-group><h2>' + title + '</h2><ul>' +
        links.map(function (item) {
          var external = /^https:/.test(item[0]);
          return '<li><a href="' + item[0] + '"' + (external ? ' target="_blank" rel="noopener noreferrer"' : '') + '>' + item[1] + '</a></li>';
        }).join('') + '</ul></div>';
    }
    document.querySelectorAll('footer, body > .footer').forEach(function (el) {
      if (el.closest('article') || el.classList.contains('card-footer')) return;
      el.setAttribute('data-bf-legacy-footer', '');
      el.setAttribute('aria-hidden', 'true');
      el.inert = true;
    });
    var style = document.createElement('style');
    style.textContent = `
      [data-bf-legacy-footer]{display:none!important}
      #bf-site-footer,#bf-site-footer *{box-sizing:border-box}
      #bf-site-footer{
        --bf-mono:'Courier Prime','Courier New',ui-monospace,monospace;
        --bf-paper:#efefe7;
        --bf-rule:rgba(26,26,26,0.08);
        --bf-black:#0a0a0a;
        --bf-ink:#161614;
        --bf-ink-2:#2a2a26;
        --bf-gray-soft:#6b6b6b;
        --bf-green:#1a6b3a;
        --bf-green-strong:#14542d;
        visibility:visible;position:relative;clear:both;
        width:calc(100% + var(--bf-foot-left,0px) + var(--bf-foot-right,0px));
        margin:64px calc(-1 * var(--bf-foot-right,0px)) calc(-1 * var(--bf-foot-bottom,0px)) calc(-1 * var(--bf-foot-left,0px));
        background:var(--bf-paper);color:var(--bf-ink);
        border-top:1px solid var(--bf-rule);
        font-family:var(--bf-mono);font-size:13px;line-height:1.6;
        text-align:left;letter-spacing:normal
      }
      html[data-theme="dark"] #bf-site-footer{
        --bf-paper:#131310;
        --bf-rule:rgba(255,255,255,0.08);
        --bf-black:#f1f1ea;
        --bf-ink:#e5e5dc;
        --bf-ink-2:#c9c9bf;
        --bf-gray-soft:#a3a39a;
        --bf-green:#2fa05a;
        --bf-green-strong:#46c277;
      }
      #bf-site-footer .bf-foot-inner{max-width:1240px;margin:0 auto;padding:48px 28px 32px}
      #bf-site-footer .bf-foot-grid{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:40px;margin-bottom:36px}
      #bf-site-footer .bf-foot-grid>div{min-width:0}
      #bf-site-footer a{color:var(--bf-ink-2);text-decoration:none;overflow-wrap:anywhere;font-family:var(--bf-mono);transition:color 200ms cubic-bezier(.2,.7,.2,1)}
      #bf-site-footer a:hover{color:var(--bf-green-strong)}
      #bf-site-footer a:focus-visible{outline:2px solid var(--bf-green);outline-offset:3px}
      #bf-site-footer .bf-foot-logo{display:inline-block;font-family:var(--bf-mono);font-weight:700;font-size:17px;letter-spacing:0.22em;color:var(--bf-black);padding:0}
      #bf-site-footer .bf-foot-logo span{display:inline-block;animation:bf-blink 1.2s steps(1) infinite;color:var(--bf-green);margin-left:2px}
      #bf-site-footer .bf-foot-brand p{font-family:var(--bf-mono);font-size:12px;line-height:1.7;letter-spacing:0.005em;margin:12px 0 0;color:var(--bf-gray-soft);max-width:32ch}
      #bf-site-footer h2{font-family:var(--bf-mono);font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;margin:0 0 14px;color:var(--bf-gray-soft);border:0;padding:0}
      #bf-site-footer ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}
      #bf-site-footer li{margin:0;padding:0;list-style:none}
      #bf-site-footer li a{display:inline-flex;align-items:center;padding:2px 0;font-family:var(--bf-mono);font-size:13px;line-height:1.5}
      #bf-site-footer .bf-foot-bottom{border-top:1px solid var(--bf-rule);padding-top:24px;display:flex;justify-content:space-between;gap:24px;align-items:flex-start;flex-wrap:wrap;font-family:var(--bf-mono);font-size:11px;color:var(--bf-gray-soft)}
      #bf-site-footer .bf-foot-meta{display:flex;flex-direction:column;gap:10px}
      #bf-site-footer .bf-foot-copyright{font-family:var(--bf-mono);font-size:11px;line-height:1.6;margin:0;color:var(--bf-gray-soft)}
      #bf-site-footer .bf-foot-tools{display:flex;gap:18px;flex-wrap:wrap;font-family:var(--bf-mono);font-size:11px}
      #bf-site-footer .bf-foot-tools a{color:var(--bf-gray-soft)}
      #bf-site-footer .bf-foot-tools a:hover{color:var(--bf-green-strong)}
      #bf-site-footer .bf-foot-risk{font-family:var(--bf-mono);font-size:11px;line-height:1.6;color:var(--bf-gray-soft);max-width:56ch;margin:0}
      @media(max-width:900px){
        #bf-site-footer .bf-foot-grid{grid-template-columns:1fr 1fr;gap:32px}
        #bf-site-footer .bf-foot-brand{grid-column:1/-1}
      }
      @media(max-width:600px){
        #bf-site-footer{margin-top:40px}
        #bf-site-footer .bf-foot-inner{padding:36px 18px 28px}
        #bf-site-footer .bf-foot-grid{grid-template-columns:1fr 1fr;gap:28px 20px}
        #bf-site-footer .bf-foot-brand,#bf-site-footer .bf-foot-grid>[role="navigation"]{grid-column:1/-1}
        #bf-site-footer [role="navigation"] ul{display:grid;grid-template-columns:1fr 1fr;column-gap:16px}
        #bf-site-footer .bf-foot-brand p{max-width:100%}
        #bf-site-footer h2{margin-bottom:10px;overflow-wrap:anywhere}
      }
    `;
    document.head.appendChild(style);
    var footer = document.createElement('div');
    footer.id = 'bf-site-footer';
    footer.setAttribute('role', 'contentinfo');
    var headerLanguage = document.querySelector('#bf-site-header .bf-lang');
    var languageUrl = headerLanguage ? headerLanguage.href : (ru ? 'https://belfed.com/' : 'https://belfed.ru/');
    footer.innerHTML = '<div class="bf-foot-inner"><div class="bf-foot-grid">' +
      '<div class="bf-foot-brand"><a class="bf-foot-logo" href="/" aria-label="Belfed home">BELFED<span aria-hidden="true">_</span></a><p>' +
      t.description + '</p></div>' +
      '<div role="navigation" aria-label="' + t.navLabel + '">' + group(t.explore, explore) + '</div>' +
      group(t.community, community) + group(t.legal, legal) + '</div>' +
      '<div class="bf-foot-bottom"><div class="bf-foot-meta"><p class="bf-foot-copyright">© ' + new Date().getFullYear() +
      ' Belfed Analytics. ' + t.rights + ' · ' + t.payments + '</p>' +
      '<div class="bf-foot-tools"><a class="bf-foot-language">' + t.language + '</a><a href="#bf-site-header">' +
      t.top + ' ↑</a></div></div><p class="bf-foot-risk">' + t.risk + '</p></div></div>';
    footer.querySelector('.bf-foot-language').href = languageUrl;
    footer.querySelector('a[href="#bf-site-header"]').addEventListener('click', function (event) {
      event.preventDefault();
      var logo = document.querySelector('#bf-site-header .bf-logo');
      if (logo) logo.focus({ preventScroll: true });
      var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: 0, behavior: reducedMotion ? 'instant' : 'smooth' });
    });
    document.body.appendChild(footer);
    function fitBody() {
      var bodyStyle = getComputedStyle(document.body);
      footer.style.setProperty('--bf-foot-left', bodyStyle.paddingLeft);
      footer.style.setProperty('--bf-foot-right', bodyStyle.paddingRight);
      footer.style.setProperty('--bf-foot-bottom', bodyStyle.paddingBottom);
    }
    fitBody();
    window.addEventListener('resize', fitBody);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();

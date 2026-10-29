/* Shared RU/EN footer. Local admin tools and redirect shells are excluded by sync. */
(function () {
  'use strict';
  var siteLanguage = document.currentScript && document.currentScript.dataset.lang;
  function mount() {
    if (document.getElementById('bf-site-footer')) return;
    var ru = siteLanguage ? siteLanguage === 'ru' : location.hostname === 'belfed.ru';
    var t = ru ? {
      description: 'Независимая аналитика мировых рынков. Исследования и торговые идеи по акциям, криптовалютам и сырьевым активам.',
      explore: 'Навигация', community: 'Сообщество', legal: 'Правовая информация',
      home: 'Главная', service: 'Сервис', how: 'Как это работает', research: 'Исследования',
      trades: 'История сделок', learn: 'Обучение', pricing: 'Тарифы', about: 'О нас',
      members: 'Кабинет', freeAnalysis: 'Бесплатный анализ',
      terms: 'Договор-оферта', privacy: 'Конфиденциальность', disclaimer: 'Раскрытие рисков', contact: 'Связаться с нами',
      bot: 'Telegram-бот', rights: 'Все права защищены.', payments: 'Платежи через Tribute.',
      risk: 'Трейдинг сопряжён со значительным риском убытков. Прошлые результаты не гарантируют будущих. Ничто на этом сайте не является финансовой рекомендацией.',
      language: 'English version', top: 'Наверх', navLabel: 'Навигация в подвале сайта'
    } : {
      description: 'Independent global market analytics. Research and trade ideas across equities, cryptocurrencies and commodities.',
      explore: 'Explore', community: 'Community', legal: 'Legal information',
      home: 'Home', service: 'Service', how: 'How it works', research: 'Research',
      trades: 'Track record', learn: 'Learn', pricing: 'Pricing', about: 'About',
      members: 'Members', freeAnalysis: 'Free analysis',
      terms: 'Terms of service', privacy: 'Privacy policy', disclaimer: 'Risk disclaimer', contact: 'Contact us',
      bot: 'Telegram bot', rights: 'All rights reserved.', payments: 'Payments by Tribute.',
      risk: 'Trading involves substantial risk of loss. Past performance is not indicative of future results. Nothing on this site is financial advice.',
      language: 'Русская версия', top: 'Back to top', navLabel: 'Footer navigation'
    };
    var explore = [
      ['/', t.home], ['/#tour', t.service], ['/#how', t.how], ['/research/', t.research],
      [ru ? '/ru/trades.html' : '/trades.html', t.trades], ['/learn/', t.learn],
      ['/#pricing', t.pricing], [ru ? '/ru/about.html' : '/about.html', t.about],
      ['/#faq', 'FAQ'], ['/#free-analysis', t.freeAnalysis], ['/members.html', t.members]
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
      // Do not suppress semantic article footnotes or card-level metadata.
      if (el.closest('article') || el.classList.contains('card-footer')) return;
      el.setAttribute('data-bf-legacy-footer', '');
      el.setAttribute('aria-hidden', 'true');
      el.inert = true;
    });
    var style = document.createElement('style');
    style.textContent = `
      [data-bf-legacy-footer]{display:none!important}
      #bf-site-footer,#bf-site-footer *{box-sizing:border-box}
      #bf-site-footer{visibility:visible;position:relative;clear:both;width:calc(100% + var(--bf-foot-left,0px) + var(--bf-foot-right,0px));margin:64px calc(-1 * var(--bf-foot-right,0px)) calc(-1 * var(--bf-foot-bottom,0px)) calc(-1 * var(--bf-foot-left,0px));background:#f5f2eb;color:#151713;border-top:1px solid #d8d8cb;font:14px/1.6 Arial,sans-serif;text-align:left;letter-spacing:normal}
      #bf-site-footer .bf-foot-inner{max-width:1480px;margin:0 auto;padding:52px 32px 28px}
      #bf-site-footer .bf-foot-grid{display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;gap:48px}
      #bf-site-footer .bf-foot-grid>div{min-width:0}
      #bf-site-footer a{color:#4d5147;text-decoration:none;overflow-wrap:anywhere;letter-spacing:normal}
      #bf-site-footer a:hover{color:#151713;text-decoration:underline;text-underline-offset:4px}
      #bf-site-footer a:focus-visible{outline:2px solid #526441;outline-offset:4px}
      #bf-site-footer .bf-foot-logo{display:inline-block;font:700 24px/1.4 'Courier New',monospace;letter-spacing:-1px;color:#151713;padding:0}
      #bf-site-footer .bf-foot-logo span{color:#526441}
      #bf-site-footer .bf-foot-brand p{font:14px/1.75 Arial,sans-serif;margin:18px 0 20px;color:#4d5147;max-width:300px}
      #bf-site-footer .bf-foot-email{font-size:13px}
      #bf-site-footer h2{font:600 12px/1.5 Arial,sans-serif;letter-spacing:1px;text-transform:uppercase;margin:4px 0 16px;color:#151713;border:0;padding:0}
      #bf-site-footer ul{list-style:none;padding:0;margin:0}
      #bf-site-footer li{margin:0;padding:0;list-style:none}
      #bf-site-footer li a{display:inline-flex;align-items:center;min-height:36px;padding:6px 0;font:13px/1.5 Arial,sans-serif}
      #bf-site-footer .bf-foot-bottom{border-top:1px solid #d8d8cb;margin-top:36px;padding-top:24px;display:flex;justify-content:space-between;gap:20px;align-items:flex-start;flex-wrap:wrap}
      #bf-site-footer .bf-foot-copyright{font:12px/1.7 Arial,sans-serif;margin:0;color:#4d5147}
      #bf-site-footer .bf-foot-tools{display:flex;gap:24px;flex-wrap:wrap;font-size:12px}
      #bf-site-footer .bf-foot-tools a{display:inline-flex;align-items:center;min-height:44px}
      #bf-site-footer .bf-foot-risk{font:12px/1.8 Arial,sans-serif;color:#4d5147;max-width:920px;margin:16px 0 0}
      @media(max-width:1000px){
        #bf-site-footer .bf-foot-grid{grid-template-columns:1fr 1fr;gap:32px 40px}
        #bf-site-footer .bf-foot-inner{padding:40px 24px 24px}
      }
      @media(max-width:600px){
        #bf-site-footer{margin-top:40px}
        #bf-site-footer .bf-foot-inner{padding:32px 20px 24px}
        #bf-site-footer .bf-foot-grid{grid-template-columns:1fr 1fr;gap:28px 20px}
        #bf-site-footer .bf-foot-brand,#bf-site-footer .bf-foot-grid>[role="navigation"]{grid-column:1/-1}
        #bf-site-footer [role="navigation"] ul{display:grid;grid-template-columns:1fr 1fr;column-gap:20px}
        #bf-site-footer .bf-foot-brand p{max-width:100%;margin:14px 0}
        #bf-site-footer h2{margin-bottom:10px;overflow-wrap:anywhere}
        #bf-site-footer li a{min-height:44px;font-size:14px}
        #bf-site-footer .bf-foot-bottom{margin-top:28px;padding-top:20px;gap:12px}
        #bf-site-footer .bf-foot-tools{width:100%;justify-content:space-between;gap:12px}
      }
    `;
    document.head.appendChild(style);
    var footer = document.createElement('div');
    footer.id = 'bf-site-footer';
    footer.setAttribute('role', 'contentinfo');
    var headerLanguage = document.querySelector('#bf-site-header .bf-lang');
    var languageUrl = headerLanguage ? headerLanguage.href : (ru ? 'https://belfed.com/' : 'https://belfed.ru/');
    footer.innerHTML = '<div class="bf-foot-inner"><div class="bf-foot-grid">' +
      '<div class="bf-foot-brand"><a class="bf-foot-logo" href="/" aria-label="BelFed">BELFED<span>_</span></a><p>' +
      t.description + '</p><a class="bf-foot-email" href="mailto:hello@belfed.com">hello@belfed.com</a></div>' +
      '<div role="navigation" aria-label="' + t.navLabel + '">' + group(t.explore, explore) + '</div>' +
      group(t.community, community) + group(t.legal, legal) + '</div>' +
      '<div class="bf-foot-bottom"><p class="bf-foot-copyright">© ' + new Date().getFullYear() +
      ' BelFed Analytics. ' + t.rights + '<br>' + t.payments + '</p>' +
      '<div class="bf-foot-tools"><a class="bf-foot-language">' + t.language + '</a><a href="#bf-site-header">' +
      t.top + ' ↑</a></div></div><p class="bf-foot-risk">' + t.risk + '</p></div>';
    footer.querySelector('.bf-foot-language').href = languageUrl;
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

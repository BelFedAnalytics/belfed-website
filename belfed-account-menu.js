/* BelFed — account menu (шапка продуктовых страниц)
 * Заменяет собой связку «НАСТРОЙКИ + ЯЗЫК + ВЫЙТИ» одной кнопкой с выпадающим меню.
 *
 * Подключение:
 *   1. <script src="/belfed-account-menu.js"></script>  (после belfed-auth.js)
 *   2. В .header-actions оставить только «← КАБИНЕТ» и <div id="acctMenuMount"></div>
 *   3. Внутри своего onAuthReady(profile, session, entitlement) вызвать:
 *        BelfedAccountMenu.update(profile, session, entitlement);
 *
 * Опционально: если на странице есть setLang('ru'|'en'), в меню появляется
 * встроенный переключатель языка (он же становится доступен на мобильных,
 * где старый .lang-switch был скрыт).
 */
(function () {
  'use strict';

  // Язык определяем лениво, а не один раз при загрузке скрипта: страница
  // может переопределить его позже — belfed.com выставляет lang по хосту
  // и по ?lang= на DOMContentLoaded, то есть уже после этого файла.
  // Порядок источников: state.lang страницы -> <html lang> -> ru.
  function curLang() {
    var l;
    try {
      l = (window.state && window.state.lang)
        || document.documentElement.getAttribute('lang') || 'ru';
    } catch (e) { l = 'ru'; }
    l = String(l).slice(0, 2).toLowerCase();
    return l === 'en' ? 'en' : 'ru';
  }

  var T = {
    ru: {
      btn: 'АККАУНТ',
      settings: 'НАСТРОЙКИ',
      email: 'E-MAIL УВЕДОМЛЕНИЯ',
      telegram: 'TELEGRAM',
      lang: 'ЯЗЫК',
      logout: 'ВЫЙТИ',
      aria: 'Меню аккаунта',
      status: { active: 'Активна', trialing: 'Триал', trial: 'Триал', expired: 'Истёк', none: 'Нет подписки', admin: 'Админ' },
      until: 'до'
    },
    en: {
      btn: 'ACCOUNT',
      settings: 'SETTINGS',
      email: 'EMAIL PREFERENCES',
      telegram: 'TELEGRAM',
      lang: 'LANGUAGE',
      logout: 'LOGOUT',
      aria: 'Account menu',
      status: { active: 'Active', trialing: 'Trial', trial: 'Trial', expired: 'Expired', none: 'No subscription', admin: 'Admin' },
      until: 'until'
    }
  };

  var CSS = [
    '.acct-menu{position:absolute;right:0;top:50%;transform:translateY(-50%);text-align:left}',
    '.acct-btn{font-family:\'Courier New\',monospace;font-size:11px;letter-spacing:1px;padding:6px 14px;background:none;border:1px solid #000;color:#000;cursor:pointer;display:inline-flex;align-items:center;gap:7px;line-height:1}',
    '.acct-btn:hover{background:#000;color:#f5f2eb}',
    '.acct-btn .caret{font-size:8px;line-height:1;transition:transform .16s ease}',
    '.acct-menu.open .acct-btn{background:#000;color:#f5f2eb}',
    '.acct-menu.open .acct-btn .caret{transform:rotate(180deg)}',
    '.acct-dd{position:absolute;right:0;top:calc(100% + 6px);min-width:236px;background:#f5f2eb;border:1px solid #000;box-shadow:4px 4px 0 rgba(0,0,0,.16);z-index:60}',
    '.acct-dd[hidden]{display:none}',
    '.acct-who{font-family:\'Courier New\',monospace;font-size:9.5px;letter-spacing:.5px;line-height:1.55;padding:9px 13px;border-bottom:1px solid #000;background:#efeae0;color:#4a463d;word-break:break-all}',
    '.acct-who .plan{display:block;color:#000;margin-top:2px}',
    '.acct-dd a,.acct-dd button.acct-item{display:block;width:100%;text-align:left;box-sizing:border-box;font-family:\'Courier New\',monospace;font-size:10.5px;letter-spacing:1.1px;padding:9px 13px;color:#000;text-decoration:none;background:none;border:none;border-bottom:1px solid #ddd8cc;cursor:pointer;line-height:1.3}',
    '.acct-dd a:hover,.acct-dd button.acct-item:hover,.acct-dd a:focus-visible,.acct-dd button.acct-item:focus-visible{background:#000;color:#f5f2eb;outline:none}',
    '.acct-dd .acct-danger{border-bottom:none;border-top:1px solid #000}',
    '.acct-langrow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 13px;border-bottom:1px solid #ddd8cc;font-family:\'Courier New\',monospace;font-size:10.5px;letter-spacing:1.1px}',
    '.acct-langrow .acct-langbtns{display:flex;border:1px solid #000}',
    '.acct-langrow button{font-family:\'Courier New\',monospace;font-size:10px;letter-spacing:1px;padding:3px 9px;background:none;border:none;cursor:pointer;color:#000;line-height:1.4}',
    '.acct-langrow button.active{background:#000;color:#f5f2eb}',
    // мобильные: шапка становится колонкой, кнопка встаёт в общий флекс-ряд
    '@media(max-width:900px){',
    '#acctMenuMount{flex:1 1 auto;display:flex;min-width:104px;max-width:160px}',
    // position:relative (а не static) — чтобы список висел под кнопкой, а не поверх неё
    '.acct-menu{position:relative;top:auto;transform:none;width:100%;display:flex}',
    '.acct-btn{min-height:40px;justify-content:center;width:100%;font-size:10px;letter-spacing:.8px;padding:7px 12px}',
    // на мобильных список центрируем по экрану и ограничиваем его шириной,
    // иначе длинные подписи (EMAIL PREFERENCES) выносят список за правый край
    '.acct-dd{position:fixed;left:50%;right:auto;transform:translateX(-50%);width:calc(100vw - 28px);max-width:340px;min-width:0}',
    '}'
  ].join('');

  function injectCSS() {
    if (document.getElementById('acct-menu-css')) return;
    var s = document.createElement('style');
    s.id = 'acct-menu-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  var root = null, btn = null, dd = null, whoEl = null;
  var builtLang = null;

  function close() {
    if (!root || !root.classList.contains('open')) return;
    root.classList.remove('open');
    dd.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }

  var MOBILE = 900;

  function open() {
    if (!root) return;
    root.classList.add('open');
    dd.hidden = false;
    // fixed-позиционирование на мобильных требует явного top:
    // считаем его от нижней границы кнопки при каждом открытии
    if (window.innerWidth <= MOBILE) {
      dd.style.top = Math.round(btn.getBoundingClientRect().bottom + 6) + 'px';
    } else {
      dd.style.top = '';
    }
    btn.setAttribute('aria-expanded', 'true');
  }

  function toggle() {
    if (root.classList.contains('open')) close(); else open();
  }

  function build() {
    var mount = document.getElementById('acctMenuMount');
    if (!mount || mount.dataset.built === '1') return;
    mount.dataset.built = '1';
    builtLang = curLang();

    var t = T[curLang()];
    var hasLang = (typeof window.setLang === 'function');

    root = document.createElement('div');
    root.className = 'acct-menu';

    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'acct-btn';
    btn.id = 'acctMenuBtn';
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', t.aria);
    btn.innerHTML = '<span class="acct-btn-label">' + t.btn + '</span><span class="caret">\u25BC</span>';

    dd = document.createElement('div');
    dd.className = 'acct-dd';
    dd.id = 'acctMenuDd';
    dd.setAttribute('role', 'menu');
    dd.hidden = true;

    whoEl = document.createElement('div');
    whoEl.className = 'acct-who';
    whoEl.id = 'acctMenuWho';
    whoEl.textContent = '\u2014';
    dd.appendChild(whoEl);

    [['/settings.html', t.settings],
     ['/settings.html#email', t.email],
     ['/settings.html#telegram', t.telegram]].forEach(function (pair) {
      var a = document.createElement('a');
      a.setAttribute('role', 'menuitem');
      a.href = pair[0];
      a.textContent = pair[1];
      dd.appendChild(a);
    });

    if (hasLang) {
      var row = document.createElement('div');
      row.className = 'acct-langrow';
      row.innerHTML = '<span>' + t.lang + '</span><span class="acct-langbtns">' +
        '<button type="button" data-lang="ru">RU</button>' +
        '<button type="button" data-lang="en">EN</button></span>';
      row.querySelectorAll('button[data-lang]').forEach(function (b) {
        b.addEventListener('click', function () {
          try { window.setLang(b.dataset.lang); } catch (e) { console.error(e); }
          syncLangButtons();
        });
      });
      dd.appendChild(row);
    } else {
      var la = document.createElement('a');
      la.setAttribute('role', 'menuitem');
      la.href = '/settings.html#language';
      la.textContent = t.lang;
      dd.appendChild(la);
    }

    var out = document.createElement('button');
    out.type = 'button';
    out.className = 'acct-item acct-danger';
    out.setAttribute('role', 'menuitem');
    out.textContent = t.logout;
    out.addEventListener('click', function () {
      close();
      if (typeof window.handleLogout === 'function') window.handleLogout();
    });
    dd.appendChild(out);

    btn.addEventListener('click', function (e) { e.stopPropagation(); toggle(); });
    root.appendChild(btn);
    root.appendChild(dd);
    mount.appendChild(root);

    // шапка — содержащий блок для absolute-меню. Без явного z-index её
    // перекрывают позиционированные блоки, идущие ниже по документу.
    var hdr = mount.closest('header');
    if (hdr) {
      var pos = getComputedStyle(hdr).position;
      if (pos === 'static') hdr.style.position = 'relative';
      hdr.style.zIndex = '120';
    }

    // клик вне меню
    document.addEventListener('click', function (e) {
      if (root && !root.contains(e.target)) close();
    });
    // Esc возвращает фокус на кнопку
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && root && root.classList.contains('open')) { close(); btn.focus(); }
    });

    syncLangButtons();
  }

  function syncLangButtons() {
    ensureLang();
    if (!dd) return;
    var cur = curLang();
    dd.querySelectorAll('button[data-lang]').forEach(function (b) {
      if (b.dataset.lang === cur) b.classList.add('active'); else b.classList.remove('active');
    });
  }

  function fmtDate(d) {
    try { return d.toLocaleDateString(curLang() === 'en' ? 'en-GB' : 'ru-RU', { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch (e) { return d.toISOString().slice(0, 10); }
  }

  // Меню собирается раньше, чем страница успевает переопределить язык
  // (наш DOMContentLoaded-слушатель регистрируется выше по документу, чем
  // страничный). Если язык с момента сборки поменялся — пересобираем.
  function ensureLang() {
    var mount = document.getElementById('acctMenuMount');
    if (!mount || mount.dataset.built !== '1' || builtLang === curLang()) return;
    var wasOpen = !!(root && root.classList.contains('open'));
    mount.innerHTML = '';
    mount.dataset.built = '';
    root = btn = dd = whoEl = null;
    build();
    if (wasOpen) open();
  }

  function update(profile, session, entitlement) {
    build();
    ensureLang();
    if (!whoEl) return;
    var t = T[curLang()];

    var email = (session && session.user && session.user.email) || '\u2014';
    var st = (entitlement && entitlement.status) || (profile && profile.subscription_status) || 'none';
    var label = t.status[st] || String(st).toUpperCase();

    // дата окончания: сначала период подписки, потом триал
    var end = null;
    var sub = entitlement && entitlement.subscription;
    if (sub) {
      var raw = sub.current_period_end || sub.expires_at || sub.period_end || null;
      if (raw) { var d = new Date(raw); if (!isNaN(d.getTime())) end = d; }
    }
    if (!end && (st === 'trial' || st === 'trialing') && profile && profile.trial_end) {
      var td = new Date(profile.trial_end);
      if (!isNaN(td.getTime())) end = td;
    }

    var plan = '// ' + label + (end ? ' \u00b7 ' + t.until + ' ' + fmtDate(end) : '');
    whoEl.innerHTML = '';
    whoEl.appendChild(document.createTextNode(email));
    var span = document.createElement('span');
    span.className = 'plan';
    span.textContent = plan;
    whoEl.appendChild(span);
  }

  injectCSS();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }

  window.addEventListener('resize', function () { if (root && root.classList.contains('open')) close(); });

  window.BelfedAccountMenu = { update: update, build: build, close: close, syncLang: syncLangButtons };
})();

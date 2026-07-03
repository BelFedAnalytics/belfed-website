// belfed-subscription.js — RU only, single plan, 14-day trial без карты.
// Виджет «Моя подписка». Подключается после supabase-js и belfed-auth.js.
(function () {
  'use strict';

  const SUPABASE_URL = 'https://obujqvqqmyfcfflhqvud.supabase.co';
  const FN_LINK      = SUPABASE_URL + '/functions/v1/telegram-link-start';
  const PRICE_RUB    = 1500;

  // Tribute checkout URLs — kept in sync with belfed-payments.js. When the
  // user has already picked a channel we can open the exact URL directly
  // without relying on the auto-detected in-app / web branch.
  const TRIBUTE_TG_URL_RU  = 'https://t.me/tribute/app?startapp=sZH9';
  const TRIBUTE_WEB_URL_RU = 'https://web.tribute.tg/s/ZH9';

  // Legacy no-op. BelFed no longer operates yookassa-cancel-subscription
  // (all billing is on Tribute; cancellation lives in the @tribute bot).
  // Retained only as a defensive stub for any external caller that still
  // imports window.BelfedSubscription.cancelSubscription.
  async function cancelSubscription() {
    throw new Error('Отмена подписки теперь выполняется в Telegram: @tribute → My subscriptions.');
  }

  function getClient() {
    return window.supaClient || window.belfedSupabase || window.supabaseClient;
  }
  async function token() {
    const c = getClient();
    const { data } = await c.auth.getSession();
    if (!data?.session) throw new Error('Войдите в аккаунт');
    return data.session.access_token;
  }

  async function generateTelegramLink() {
    const t = await token();
    const r = await fetch(FN_LINK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t },
      body: '{}',
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Не удалось создать ссылку');
    return j;
  }

  async function loadStatus() {
    const c = getClient();
    const { data: { session } } = await c.auth.getSession();
    if (!session) return null;
    // Subscriptions: pick the newest one, provider-agnostic (tribute, telegram_stars, ...).
    // BelFed migrated fully off YooKassa on 2026-07-03; historical yookassa rows may still exist.
    // Users may legitimately have multiple rows across providers/history — prefer active,
    // otherwise fall back to the most recent by current_period_end.
    const [{ data: prof }, { data: subs }] = await Promise.all([
      c.from('profiles')
        .select('subscription_status, subscription_plan, subscription_expires_at, telegram_id, telegram_username, trial_started_at, trial_end')
        .eq('id', session.user.id).maybeSingle(),
      c.from('subscriptions')
        .select('status, plan_code, provider, current_period_end, cancel_at_period_end, payment_method_id')
        .eq('user_id', session.user.id)
        .order('current_period_end', { ascending: false, nullsFirst: false })
        .limit(5),
    ]);
    const list = Array.isArray(subs) ? subs : [];
    const sub = list.find(s => s.status === 'active') || list[0] || null;
    return { profile: prof, subscription: sub };
  }

  function fmt(d) { return new Date(d).toLocaleDateString('ru-RU'); }
  function daysLeft(d) {
    return Math.max(0, Math.ceil((new Date(d) - new Date()) / 86400000));
  }

  // Показать промежуточный «обрабатываем платёж» баннер.
  function renderProcessing(box) {
    box.innerHTML =
      '<div class="bf-card">' +
        '<div class="bf-status bf-status--trial">⏳ Подтверждаем оплату…</div>' +
        '<div class="bf-row">Это занимает 5–20 секунд. Страница обновится автоматически.</div>' +
      '</div>';
  }

  // Дождаться, пока подписка станет active (после ?payment=success).
  // Опрашивает loadStatus до ~30 секунд, возвращает свежий state как только status=active.
  async function waitUntilActive(maxMs) {
    const deadline = Date.now() + (maxMs || 30000);
    while (Date.now() < deadline) {
      try {
        const st = await loadStatus();
        if (st && st.subscription && st.subscription.status === 'active') return st;
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 2000));
    }
    return null;
  }

  async function render() {
    const box = document.getElementById('belfedSubscriptionBox');
    if (!box) return;

    // Возврат с Tribute checkout: ?payment=success|return → ждём активации.
    let paymentSuccess = false;
    try {
      const url = new URL(window.location.href);
      paymentSuccess = url.searchParams.get('payment') === 'success';
    } catch (_) {}

    if (paymentSuccess) {
      renderProcessing(box);
      const fresh = await waitUntilActive(30000);
      // Очищаем флаг из URL чтобы при перезагрузке не зацикливаться.
      try {
        const u = new URL(window.location.href);
        u.searchParams.delete('payment');
        window.history.replaceState({}, '', u.toString());
      } catch (_) {}
      if (fresh) {
        // Покажем зелёный тост поверх стандартного рендера ниже.
        setTimeout(() => {
          const msg = document.getElementById('bfMsg');
          if (msg) {
            msg.style.color = '#2e7d32';
            msg.textContent = '✅ Оплата прошла. Подписка активна.';
          }
        }, 50);
      }
      // ниже идёт обычный рендер актуального состояния
    }

    let state;
    try {
      state = await loadStatus();
    } catch (err) {
      // Never leave the card empty when there is a session — the QA report
      // 2026-07-03 flagged that an expired user saw a blank "// Моя подписка"
      // section with no payment CTA. Render a minimal upsell fallback instead.
      console.error('belfed-subscription loadStatus failed:', err);
      box.innerHTML =
        '<div class="bf-card">' +
          '<div class="bf-status">❗ Не удалось загрузить статус подписки</div>' +
          '<div class="bf-row bf-muted">Попробуйте перезагрузить страницу. Ниже прямые ссылки на оплату через Tribute:</div>' +
          '<div class="bf-pay-grid" style="margin-top:12px">' +
            '<a class="bf-pay-btn bf-pay-btn--primary" href="' + TRIBUTE_TG_URL_RU + '" target="_blank" rel="noopener"><span class="bf-pay-text"><b>Через Telegram</b><small>' + PRICE_RUB + ' ₽ / мес</small></span></a>' +
            '<a class="bf-pay-btn bf-pay-btn--secondary" href="' + TRIBUTE_WEB_URL_RU + '" target="_blank" rel="noopener"><span class="bf-pay-text"><b>Через браузер</b><small>' + PRICE_RUB + ' ₽ / мес</small></span></a>' +
          '</div>' +
        '</div>';
      return;
    }
    if (!state) {
      // No session at all — nothing to render here; auth screen handles it.
      box.textContent = '';
      return;
    }

    const { profile, subscription } = state;
    const exp = profile?.subscription_expires_at ? new Date(profile.subscription_expires_at) : null;
    const trialEnd = profile?.trial_end ? new Date(profile.trial_end) : null;
    const isAdmin = profile?.subscription_status === 'admin';
    const hasAccess = (exp && exp > new Date()) || (trialEnd && trialEnd > new Date()) || isAdmin;
    const isPaid = subscription && subscription.status === 'active' && exp && exp > new Date();
    const isTrial = !isPaid && !isAdmin && profile?.subscription_status === 'trial'
                    && trialEnd && trialEnd > new Date();
    const autorenew = isPaid && !subscription.cancel_at_period_end;

    let html = '';

    // ====== STATUS PANEL ======
    html += '<div class="bf-card">';
    if (isAdmin) {
      html += `<div class="bf-status bf-status--ok">✨ АДМИНИСТРАТОР</div>`;
      html += `<div class="bf-row">Полный доступ ко всем разделам без подписки.</div>`;
    } else if (isPaid) {
      html += `<div class="bf-status bf-status--ok">✅ ПОДПИСКА АКТИВНА</div>`;
      html += `<div class="bf-row">План: месячный · ${PRICE_RUB} ₽ / мес</div>`;
      html += `<div class="bf-row">Действует до: <b>${fmt(exp)}</b></div>`;
      html += `<div class="bf-row">Автопродление: <b class="${autorenew?'bf-on':'bf-off'}">${autorenew?'включено':'отключено'}</b></div>`;
    } else if (isTrial) {
      html += `<div class="bf-status bf-status--trial">🎁 ПРОБНЫЙ ДОСТУП · 14 дней</div>`;
      html += `<div class="bf-row">Действует до: <b>${fmt(trialEnd)}</b> · осталось ${daysLeft(trialEnd)} дн.</div>`;
      html += `<div class="bf-row bf-muted">После триала — подписка ${PRICE_RUB} ₽ / мес. Карта не привязана: оплата только по вашему действию.</div>`;
    } else {
      // Covers subscription_status in ('expired', 'none') and any other
      // non-access state. Show an explicit expired label when appropriate
      // so the QA-flagged blank-card bug (2026-07-03) can never recur.
      var isExpired = profile && profile.subscription_status === 'expired';
      html += `<div class="bf-status">${isExpired ? '⏳ ДОСТУП ЗАВЕРШЁН' : '❌ ПОДПИСКИ НЕТ'}</div>`;
      html += `<div class="bf-row bf-muted">${isExpired
        ? 'Ваш пробный / платный доступ завершён. Оформите подписку, чтобы вернуть доступ к торговым сигналам и аналитике.'
        : 'Оформите подписку, чтобы получить доступ в закрытый канал.'
      }</div>`;
    }
    html += `<div class="bf-row">Telegram: ${profile?.telegram_id ? '<b>@' + (profile.telegram_username || profile.telegram_id) + '</b>' : '<span class="bf-muted">не привязан</span>'}</div>`;
    html += '</div>';

    // ====== ACTION BUTTONS ======
    html += '<div class="bf-actions">';
    if (!profile?.telegram_id) {
      html += '<div class="bf-row bf-muted" style="margin-bottom:10px">Доступ открыт по простой регистрации — без привязки карты. Если пользуетесь Telegram, можно привязать @BelfedBot для торговых возможностей, аналитики и обзоров рынка.</div>';
      html += '<button id="bfLinkTg" class="login-btn">🔗 Привязать Telegram (опционально)</button>';
    }
    if (!isPaid && !isAdmin) {
      // Two explicit Tribute checkout channels so users can pick the one they trust.
      // Both open Tribute in a new tab; no data ever hits belfed.ru servers.
      html +=
        '<div class="bf-pay-title">💳 Оформить подписку — ' + PRICE_RUB + ' ₽ / мес</div>' +
        '<div class="bf-pay-sub">Оплата через Tribute — выберите удобный вариант:</div>' +
        '<div class="bf-pay-grid">' +
          '<a class="bf-pay-btn bf-pay-btn--primary" href="' + TRIBUTE_TG_URL_RU + '" target="_blank" rel="noopener" data-belfed-pay="tg">' +
            '<span class="bf-pay-icon" aria-hidden="true">' +
              '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9.78 15.27 9.6 18.9c.36 0 .52-.15.72-.34l1.72-1.64 3.56 2.6c.65.36 1.11.17 1.29-.6l2.33-10.94c.22-.99-.36-1.38-.99-1.15L4.05 10.9c-.96.37-.95.9-.16 1.14l3.8 1.18 8.82-5.56c.42-.27.8-.12.48.16z"/></svg>' +
            '</span>' +
            '<span class="bf-pay-text"><b>Через Telegram</b><small>Откроется Tribute-бот</small></span>' +
          '</a>' +
          '<a class="bf-pay-btn bf-pay-btn--secondary" href="' + TRIBUTE_WEB_URL_RU + '" target="_blank" rel="noopener" data-belfed-pay="web">' +
            '<span class="bf-pay-icon" aria-hidden="true">' +
              '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a13.5 13.5 0 010 18M12 3a13.5 13.5 0 000 18"/></svg>' +
            '</span>' +
            '<span class="bf-pay-text"><b>Через браузер</b><small>Web-чекаут Tribute</small></span>' +
          '</a>' +
        '</div>' +
        '<div class="bf-pay-foot">Отмена в любой момент — через <a href="https://t.me/tribute" target="_blank" rel="noopener">@tribute</a>. Платежи защищены Tribute.</div>';
    }
    // Отмена автопродления и отвязка карты живут на /billing.html — здесь только ссылка.
    if (isPaid || isTrial) {
      html += '<a id="bfManage" class="login-btn" href="/billing.html" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center">⚙️ Управление подпиской и оплатой →</a>';
    }
    html += '</div>';
    html += '<p id="bfMsg" class="bf-msg"></p>';

    box.innerHTML = html;

    const linkBtn = document.getElementById('bfLinkTg');
    if (linkBtn) linkBtn.onclick = async () => {
      try {
        const r = await generateTelegramLink();
        window.open(r.deep_link, '_blank');
        document.getElementById('bfMsg').textContent =
          'Открыт Telegram. Нажмите «Start» в чате бота, чтобы завершить привязку. Токен действует 15 минут.';
      } catch (e) { alert('Ошибка: ' + e.message); }
    };

    // Fire analytics on Tribute channel picks (tg vs web). The <a> tags
    // already handle navigation via target=_blank; we just log the choice.
    box.querySelectorAll('[data-belfed-pay]').forEach(function (el) {
      el.addEventListener('click', function () {
        try {
          if (window.belfedTrack) {
            window.belfedTrack('payment_started', {
              plan: 'month',
              provider: 'tribute',
              channel: el.getAttribute('data-belfed-pay') || 'unknown',
            });
          }
        } catch (_) {}
      });
    });

    // Старая кнопка #bfCancel убрана — отмена автопродления живёт в @tribute → My subscriptions.
  }

  document.addEventListener('DOMContentLoaded', () => {
    const iv = setInterval(() => {
      if (getClient() && document.getElementById('belfedSubscriptionBox')) {
        clearInterval(iv);
        render();
      }
    }, 300);
  });

  window.BelfedSubscription = {
    generateTelegramLink, cancelSubscription, loadStatus, render,
  };
})();

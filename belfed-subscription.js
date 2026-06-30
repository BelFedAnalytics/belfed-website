// belfed-subscription.js — RU only, single plan, 7-day trial без карты.
// Виджет «Моя подписка». Подключается после supabase-js и belfed-auth.js.
(function () {
  'use strict';

  const SUPABASE_URL = 'https://obujqvqqmyfcfflhqvud.supabase.co';
  const FN_LINK      = SUPABASE_URL + '/functions/v1/telegram-link-start';
  const FN_CANCEL    = SUPABASE_URL + '/functions/v1/yookassa-cancel-subscription';
  const PRICE_RUB    = 1500;

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

  async function cancelSubscription(reason) {
    const t = await token();
    const r = await fetch(FN_CANCEL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t },
      body: JSON.stringify({ reason: reason || 'user_requested' }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Не удалось отменить');
    return j;
  }

  async function loadStatus() {
    const c = getClient();
    const { data: { session } } = await c.auth.getSession();
    if (!session) return null;
    const [{ data: prof }, { data: sub }] = await Promise.all([
      c.from('profiles')
        .select('subscription_status, subscription_plan, subscription_expires_at, telegram_id, telegram_username, trial_started_at, trial_end')
        .eq('id', session.user.id).maybeSingle(),
      c.from('subscriptions')
        .select('status, plan_code, current_period_end, cancel_at_period_end, payment_method_id')
        .eq('user_id', session.user.id).maybeSingle(),
    ]);
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

    // Возврат с YooKassa: ?payment=success → ждём активации.
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
    try { state = await loadStatus(); } catch { box.textContent = ''; return; }
    if (!state) { box.textContent = ''; return; }

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
      html += `<div class="bf-status bf-status--trial">🎁 ПРОБНЫЙ ДОСТУП · 7 дней</div>`;
      html += `<div class="bf-row">Действует до: <b>${fmt(trialEnd)}</b> · осталось ${daysLeft(trialEnd)} дн.</div>`;
      html += `<div class="bf-row bf-muted">После триала — подписка ${PRICE_RUB} ₽ / мес. Карта не привязана: оплата только по вашему действию.</div>`;
    } else {
      html += `<div class="bf-status">❌ ПОДПИСКИ НЕТ</div>`;
      html += `<div class="bf-row bf-muted">Оформите подписку, чтобы получить доступ в закрытый канал.</div>`;
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
      html += `<button id="bfPay" class="login-btn bf-cta">💳 Оформить подписку — ${PRICE_RUB} ₽ / мес</button>`;
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

    const payBtn = document.getElementById('bfPay');
    if (payBtn) payBtn.onclick = async () => {
      const msgEl = document.getElementById('bfMsg');
      payBtn.disabled = true;
      const orig = payBtn.textContent;
      payBtn.textContent = 'Перенаправляем на оплату…';
      try {
        if (!window.BelfedPayments || !window.BelfedPayments.startCheckout) {
          throw new Error('Модуль оплаты не загружен');
        }
        await window.BelfedPayments.startCheckout({ plan: 'month' });
      } catch (err) {
        if (msgEl) msgEl.textContent = 'Ошибка оплаты: ' + (err.message || err);
        payBtn.disabled = false;
        payBtn.textContent = orig;
      }
    };

    // Старая кнопка #bfCancel убрана — отмена автопродления живёт на /billing.html.
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

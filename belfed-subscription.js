// belfed-subscription.js — RU only, single plan, 14-day trial без карты.
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
        .select('subscription_plan, subscription_expires_at, telegram_id, telegram_username, trial_started_at')
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

  async function render() {
    const box = document.getElementById('belfedSubscriptionBox');
    if (!box) return;

    let state;
    try { state = await loadStatus(); } catch { box.textContent = ''; return; }
    if (!state) { box.textContent = ''; return; }

    const { profile, subscription } = state;
    const exp = profile?.subscription_expires_at ? new Date(profile.subscription_expires_at) : null;
    const hasAccess = exp && exp > new Date();
    const isPaid = subscription && subscription.status === 'active' && hasAccess;
    const isTrial = !isPaid && hasAccess && profile?.subscription_plan === 'trial';
    const autorenew = isPaid && !subscription.cancel_at_period_end;

    let html = '';

    // ====== STATUS PANEL ======
    html += '<div class="bf-card">';
    if (isPaid) {
      html += `<div class="bf-status bf-status--ok">✅ ПОДПИСКА АКТИВНА</div>`;
      html += `<div class="bf-row">План: monthly · ${PRICE_RUB} ₽ / мес</div>`;
      html += `<div class="bf-row">Действует до: <b>${fmt(exp)}</b></div>`;
      html += `<div class="bf-row">Автопродление: <b class="${autorenew?'bf-on':'bf-off'}">${autorenew?'включено':'отключено'}</b></div>`;
    } else if (isTrial) {
      const left = daysLeft(exp);
      html += `<div class="bf-status bf-status--trial">🎁 ПРОБНЫЙ ДОСТУП · 14 дней</div>`;
      html += `<div class="bf-row">Действует до: <b>${fmt(exp)}</b> · осталось ${left} дн.</div>`;
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
    if (!isPaid) {
      html += `<button id="bfPay" class="login-btn bf-cta">💳 Оформить подписку — ${PRICE_RUB} ₽ / мес</button>`;
    }
    if (autorenew) {
      html += '<button id="bfCancel" class="login-btn bf-danger">Отменить автопродление</button>';
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
    if (payBtn) payBtn.onclick = () => {
      // belfed-payments.js навешивает оплату через bindButton; здесь
      // мы просто прокидываем событие — main page bindings подхватят.
      payBtn.dispatchEvent(new CustomEvent('belfed:pay', { bubbles: true, detail: { plan: 'monthly' } }));
    };

    const cancelBtn = document.getElementById('bfCancel');
    if (cancelBtn) cancelBtn.onclick = async () => {
      if (!confirm('Отменить автопродление? Доступ сохранится до конца оплаченного периода.')) return;
      try {
        const r = await cancelSubscription('user_requested_web');
        document.getElementById('bfMsg').textContent =
          'Автопродление отключено. Доступ до ' + fmt(r.access_until) + '.';
        setTimeout(render, 800);
      } catch (e) { alert('Ошибка: ' + e.message); }
    };
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

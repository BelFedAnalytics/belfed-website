// belfed-subscription.js — RU-only
// Виджет «Моя подписка» для belfed.ru/members.html.
// Подключается после supabase-js и belfed-auth.js (window.supaClient).
(function () {
  'use strict';

  const SUPABASE_URL = 'https://obujqvqqmyfcfflhqvud.supabase.co';
  const FN_LINK      = SUPABASE_URL + '/functions/v1/telegram-link-start';
  const FN_CANCEL    = SUPABASE_URL + '/functions/v1/yookassa-cancel-subscription';

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
    return j; // { token, deep_link, expires_in_seconds }
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

  async function loadSubscriptionStatus() {
    const c = getClient();
    const { data: { session } } = await c.auth.getSession();
    if (!session) return null;

    const [{ data: prof }, { data: sub }] = await Promise.all([
      c.from('profiles')
       .select('subscription_plan, subscription_expires_at, telegram_id, telegram_username')
       .eq('id', session.user.id).maybeSingle(),
      c.from('subscriptions')
       .select('status, plan_code, current_period_end, cancel_at_period_end, payment_method_id')
       .eq('user_id', session.user.id).maybeSingle(),
    ]);
    return { profile: prof, subscription: sub };
  }

  async function renderSubscriptionBox() {
    const box = document.getElementById('belfedSubscriptionBox');
    if (!box) return;

    let state;
    try { state = await loadSubscriptionStatus(); }
    catch (e) { box.textContent = ''; return; }
    if (!state) { box.textContent = ''; return; }

    const { profile, subscription } = state;
    const exp = profile?.subscription_expires_at ? new Date(profile.subscription_expires_at) : null;
    const active = exp && exp > new Date();
    const autorenew = subscription && subscription.status === 'active' && !subscription.cancel_at_period_end;

    let html = '<div style="margin-top:16px;font-size:13px;line-height:1.7">';
    if (active) {
      html += `<div>Статус: <b>АКТИВНА</b></div>`;
      html += `<div>План: ${subscription?.plan_code ?? '—'}</div>`;
      html += `<div>Действует до: ${exp.toLocaleDateString('ru-RU')}</div>`;
      html += `<div>Автопродление: ${autorenew ? 'включено' : 'отключено'}</div>`;
    } else {
      html += `<div>Статус: <b>ПОДПИСКИ НЕТ</b></div>`;
    }
    html += `<div>Telegram: ${profile?.telegram_id ? ('@' + (profile.telegram_username || profile.telegram_id)) : 'не привязан'}</div>`;
    html += '</div>';

    html += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">';
    if (!profile?.telegram_id) {
      html += '<button id="btnLinkTg" class="login-btn" style="width:auto;padding:10px 18px;">Привязать Telegram</button>';
    }
    if (autorenew) {
      html += '<button id="btnCancelSub" class="login-btn" style="width:auto;padding:10px 18px;background:#8b1a1a;color:#fff;border-color:#8b1a1a;">Отменить автопродление</button>';
    }
    html += '</div><p id="belfedSubMsg" style="margin-top:10px;font-size:12px;color:var(--gray);"></p>';

    box.innerHTML = html;

    const linkBtn = document.getElementById('btnLinkTg');
    if (linkBtn) linkBtn.addEventListener('click', async () => {
      try {
        const r = await generateTelegramLink();
        window.open(r.deep_link, '_blank');
        document.getElementById('belfedSubMsg').textContent =
          'Открыт Telegram. Нажмите «Start» в чате бота, чтобы завершить привязку. Токен действует 15 минут.';
      } catch (e) { alert('Ошибка: ' + e.message); }
    });

    const cancelBtn = document.getElementById('btnCancelSub');
    if (cancelBtn) cancelBtn.addEventListener('click', async () => {
      if (!confirm('Отменить автопродление? Доступ сохранится до конца оплаченного периода.')) return;
      try {
        const r = await cancelSubscription('user_requested_web');
        document.getElementById('belfedSubMsg').textContent =
          'Автопродление отключено. Доступ до ' + new Date(r.access_until).toLocaleDateString('ru-RU') + '.';
        setTimeout(renderSubscriptionBox, 800);
      } catch (e) { alert('Ошибка: ' + e.message); }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    const iv = setInterval(() => {
      if (getClient() && document.getElementById('belfedSubscriptionBox')) {
        clearInterval(iv);
        renderSubscriptionBox();
      }
    }, 300);
  });

  window.BelfedSubscription = {
    generateTelegramLink,
    cancelSubscription,
    loadSubscriptionStatus,
    renderSubscriptionBox,
  };
})();

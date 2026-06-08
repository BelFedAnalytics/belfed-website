// belfed-billing.js — /billing.html
//
// Three blocks: Subscription, Payment method, Payment history.
// Used by billing.html. Requires:
//   - window.supaClient (created by belfed-auth.js)
//   - User must be signed in (handled here: shows login-required if not)
//
// Edge functions called:
//   - POST /yookassa-cancel-subscription   { reason }   -> stop auto-renewal
//   - POST /yookassa-detach-payment-method {}           -> remove saved card
//
// All copy is RU only — page is for Russian (YooKassa) flow.
(function () {
  'use strict';

  const SUPABASE_URL = 'https://obujqvqqmyfcfflhqvud.supabase.co';
  const FN_CANCEL    = SUPABASE_URL + '/functions/v1/yookassa-cancel-subscription';
  const FN_DETACH    = SUPABASE_URL + '/functions/v1/yookassa-detach-payment-method';

  function getClient() {
    return window.supaClient || window.belfedSupabase || window.supabaseClient;
  }

  async function getSession() {
    const c = getClient();
    if (!c) return null;
    const { data } = await c.auth.getSession();
    return data?.session ?? null;
  }

  async function callFn(url, body) {
    const session = await getSession();
    if (!session) throw new Error('Войдите в аккаунт');
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.access_token,
      },
      body: JSON.stringify(body || {}),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || j.message || ('HTTP ' + r.status));
    return j;
  }

  function fmtDate(d) {
    if (!d) return '—';
    try { return new Date(d).toLocaleDateString('ru-RU'); } catch { return '—'; }
  }
  function fmtDateTime(d) {
    if (!d) return '—';
    try {
      return new Date(d).toLocaleDateString('ru-RU') +
        ' ' + new Date(d).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } catch { return '—'; }
  }
  function fmtRub(amount) {
    if (amount == null) return '—';
    const n = Number(amount);
    if (!isFinite(n)) return '—';
    return n.toLocaleString('ru-RU') + ' ₽';
  }
  function brandLabel(brand) {
    if (!brand) return 'CARD';
    const map = {
      visa: 'VISA', mastercard: 'MC', master_card: 'MC', mc: 'MC',
      mir: 'МИР', maestro: 'MAESTRO', unionpay: 'UPAY', union_pay: 'UPAY',
      jcb: 'JCB', amex: 'AMEX', american_express: 'AMEX', discover: 'DISC',
    };
    return map[brand.toLowerCase()] || brand.toUpperCase();
  }

  function toast(msg, kind) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.className = 'toast';
    if (kind) t.classList.add('toast--' + kind);
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => { t.classList.remove('show'); }, 3800);
  }

  async function loadState() {
    const c = getClient();
    const session = await getSession();
    if (!session) return null;

    const [{ data: prof }, { data: sub }, { data: pays }] = await Promise.all([
      c.from('profiles')
        .select('id, email, subscription_status, subscription_plan, subscription_expires_at, telegram_id, telegram_username, trial_started_at, trial_end, founding_member, founding_locale')
        .eq('id', session.user.id).maybeSingle(),
      c.from('subscriptions')
        .select('id, status, plan_code, amount_rub, current_period_end, cancel_at_period_end, payment_method_id, card_last4, card_brand, payment_method_saved_at, payment_method_detached_at, failed_attempts, last_charge_error')
        .eq('user_id', session.user.id).maybeSingle(),
      c.from('payments')
        .select('id, amount, currency, status, paid_at, created_at, is_recurring, provider_payment_id')
        .eq('user_id', session.user.id)
        .order('created_at', { ascending: false })
        .limit(24),
    ]);
    return { session, profile: prof, subscription: sub, payments: pays || [] };
  }

  function renderSubscription(state) {
    const { profile, subscription } = state;
    const block = document.getElementById('subscriptionBlock');
    const actions = document.getElementById('subscriptionActions');
    const hint = document.getElementById('subscriptionHint');

    const exp = profile?.subscription_expires_at ? new Date(profile.subscription_expires_at) : null;
    const trialEnd = profile?.trial_end ? new Date(profile.trial_end) : null;
    const isAdmin = profile?.subscription_status === 'admin';
    const isPaid = subscription && subscription.status === 'active' && exp && exp > new Date();
    const isTrial = !isPaid && !isAdmin && profile?.subscription_status === 'trial'
                    && trialEnd && trialEnd > new Date();
    const autorenew = isPaid && !subscription.cancel_at_period_end && subscription.payment_method_id;

    // Pricing label — founding members keep 30% off forever
    const isFounding = !!profile?.founding_member;
    const monthlyAmount = subscription?.amount_rub || (isFounding ? 1050 : 1500);

    let rows = '';
    if (isAdmin) {
      rows += `<div class="billing-row"><span class="label">Статус</span><span class="value"><span class="status-badge">Администратор</span></span></div>`;
      rows += `<div class="billing-row"><span class="label">Доступ</span><span class="value">Полный, без подписки</span></div>`;
    } else if (isPaid) {
      rows += `<div class="billing-row"><span class="label">Статус</span><span class="value"><span class="status-badge">Активна</span></span></div>`;
      rows += `<div class="billing-row"><span class="label">План</span><span class="value">${isFounding ? 'BelFed · Founding Member' : 'BelFed · Месячный'}</span></div>`;
      rows += `<div class="billing-row"><span class="label">Стоимость</span><span class="value">${fmtRub(monthlyAmount)} / мес</span></div>`;
      rows += `<div class="billing-row"><span class="label">${autorenew ? 'Следующее списание' : 'Доступ до'}</span><span class="value">${fmtDate(exp)}</span></div>`;
      rows += `<div class="billing-row"><span class="label">Автопродление</span><span class="value">${autorenew ? '<span class="status-badge">Включено</span>' : '<span class="status-badge off">Отключено</span>'}</span></div>`;
    } else if (isTrial) {
      rows += `<div class="billing-row"><span class="label">Статус</span><span class="value"><span class="status-badge trial">Пробный доступ</span></span></div>`;
      rows += `<div class="billing-row"><span class="label">Триал до</span><span class="value">${fmtDate(trialEnd)}</span></div>`;
      rows += `<div class="billing-row"><span class="label">После триала</span><span class="value muted">${fmtRub(isFounding ? 1050 : 1500)} / мес</span></div>`;
    } else {
      rows += `<div class="billing-row"><span class="label">Статус</span><span class="value"><span class="status-badge expired">Подписки нет</span></span></div>`;
      rows += `<div class="billing-row"><span class="label">Стоимость</span><span class="value muted">${fmtRub(isFounding ? 1050 : 1500)} / мес</span></div>`;
    }
    block.innerHTML = rows;

    let actHtml = '';
    if (autorenew) {
      actHtml += `<button class="btn btn-danger" id="btnCancelAutorenew">Отменить автопродление</button>`;
    }
    if (!isPaid && !isAdmin) {
      actHtml += `<a class="btn btn-primary" href="/members.html#pay">Оформить подписку</a>`;
    }
    actions.innerHTML = actHtml;

    if (isPaid && autorenew) {
      hint.innerHTML = `Доступ продлится автоматически <b>${fmtDate(exp)}</b>. После отмены автопродления доступ сохранится до этой даты, дальше — отключится. Восстановить можно в любой момент новым платежом.`;
    } else if (isPaid && !autorenew) {
      hint.innerHTML = `Автопродление отключено. Доступ сохранится до <b>${fmtDate(exp)}</b>, после чего отключится. Чтобы продолжить — оформите подписку заново.`;
    } else if (isTrial) {
      hint.innerHTML = `Карта не привязана. После окончания триала доступ завершится — подписка оформляется только по вашему действию.`;
    } else if (!isAdmin) {
      hint.innerHTML = `Подпишитесь, чтобы получить доступ в закрытый Telegram-канал и к полной аналитике.`;
    } else {
      hint.textContent = '';
    }

    const btn = document.getElementById('btnCancelAutorenew');
    if (btn) {
      btn.onclick = async () => {
        if (!confirm('Отменить автопродление?\n\nДоступ сохранится до конца оплаченного периода.')) return;
        btn.disabled = true;
        const orig = btn.textContent;
        btn.textContent = 'Отменяем…';
        try {
          const r = await callFn(FN_CANCEL, { reason: 'user_requested_billing_page' });
          toast('Автопродление отключено. Доступ до ' + fmtDate(r.access_until), 'success');
          await refresh();
        } catch (e) {
          toast('Ошибка: ' + e.message, 'error');
          btn.disabled = false;
          btn.textContent = orig;
        }
      };
    }
  }

  function renderPaymentMethod(state) {
    const { subscription } = state;
    const block = document.getElementById('paymentMethodBlock');
    const actions = document.getElementById('paymentMethodActions');
    const hint = document.getElementById('paymentMethodHint');

    const hasCard = !!(subscription && subscription.payment_method_id);

    if (hasCard) {
      const last4 = subscription.card_last4 || '••••';
      const brand = brandLabel(subscription.card_brand);
      const savedAt = subscription.payment_method_saved_at;
      block.innerHTML = `
        <div class="card-display">
          <span class="card-icon">${brand}</span>
          <div class="card-meta">
            <div class="card-line1">•••• •••• •••• ${last4}</div>
            <div class="card-line2">Привязана ${fmtDate(savedAt)} · автосписания каждый месяц</div>
          </div>
        </div>
      `;
      actions.innerHTML = `<button class="btn btn-danger" id="btnDetachCard">Удалить карту</button>`;
      hint.innerHTML = `После удаления карты автоматические списания прекратятся. Текущий доступ сохранится до конца оплаченного периода. Чтобы продолжить подписку, нужно будет оформить новую оплату.`;

      const btn = document.getElementById('btnDetachCard');
      btn.onclick = async () => {
        if (!confirm('Удалить привязанную карту?\n\nАвтоматические списания прекратятся. Доступ сохранится до конца оплаченного периода.')) return;
        btn.disabled = true;
        const orig = btn.textContent;
        btn.textContent = 'Удаляем…';
        try {
          const r = await callFn(FN_DETACH, {});
          toast('Карта удалена. Доступ до ' + fmtDate(r.access_until), 'success');
          await refresh();
        } catch (e) {
          toast('Ошибка: ' + e.message, 'error');
          btn.disabled = false;
          btn.textContent = orig;
        }
      };
    } else if (subscription && subscription.payment_method_detached_at) {
      block.innerHTML = `
        <div class="empty-card-state">
          <b>Карта не привязана</b><br>
          Вы удалили карту ${fmtDate(subscription.payment_method_detached_at)}. Чтобы возобновить подписку, оформите новую оплату — карта сохранится автоматически.
        </div>
      `;
      actions.innerHTML = '';
      hint.textContent = '';
    } else {
      block.innerHTML = `
        <div class="empty-card-state">
          <b>Карта не привязана.</b><br>
          Карта сохраняется автоматически при первом успешном платеже через YooKassa. После этого подписка продлевается без вашего участия — пока вы сами не удалите карту.
        </div>
      `;
      actions.innerHTML = '';
      hint.textContent = '';
    }
  }

  function renderHistory(state) {
    const { payments } = state;
    const block = document.getElementById('historyBlock');

    const succeeded = (payments || []).filter(p => p.status === 'succeeded' || p.status === 'refunded' || p.status === 'canceled');

    if (!succeeded.length) {
      block.innerHTML = `<div class="history-empty">Пока нет платежей. Они появятся здесь сразу после первой оплаты.</div>`;
      return;
    }

    const statusMap = {
      succeeded: { label: 'Оплачено', cls: '' },
      refunded:  { label: 'Возврат', cls: 'off' },
      canceled:  { label: 'Отменён', cls: 'expired' },
      pending:   { label: 'В обработке', cls: 'trial' },
    };

    let rows = '';
    let cards = '';
    for (const p of succeeded) {
      const s = statusMap[p.status] || { label: p.status, cls: 'off' };
      const when = p.paid_at || p.created_at;
      const type = p.is_recurring ? 'Автосписание' : 'Оплата';
      rows += `<tr>
        <td>${fmtDateTime(when)}</td>
        <td class="amount">${fmtRub(p.amount)}</td>
        <td>${type}</td>
        <td class="status-cell"><span class="status-badge ${s.cls}">${s.label}</span></td>
      </tr>`;
      cards += `<div class="history-item">
        <div class="history-item-top">
          <span class="history-item-date">${fmtDateTime(when)}</span>
          <span class="history-item-amount">${fmtRub(p.amount)}</span>
        </div>
        <div class="history-item-bottom">
          <span class="history-item-type">${type}</span>
          <span class="status-badge ${s.cls}">${s.label}</span>
        </div>
      </div>`;
    }

    block.innerHTML = `
      <table class="history-table">
        <thead>
          <tr><th>Дата</th><th>Сумма</th><th>Тип</th><th>Статус</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="history-mobile">${cards}</div>
    `;
  }

  async function refresh() {
    const state = await loadState();
    if (!state) {
      document.getElementById('loginRequired').style.display = 'block';
      document.getElementById('billingContent').style.display = 'none';
      return;
    }
    document.getElementById('loginRequired').style.display = 'none';
    document.getElementById('billingContent').style.display = 'block';
    renderSubscription(state);
    renderPaymentMethod(state);
    renderHistory(state);
  }

  // Wait for the supabase client (created by belfed-auth.js) before rendering.
  document.addEventListener('DOMContentLoaded', () => {
    const iv = setInterval(() => {
      if (getClient()) {
        clearInterval(iv);
        refresh().catch((e) => {
          console.error('billing refresh failed', e);
          toast('Не удалось загрузить данные: ' + e.message, 'error');
        });
      }
    }, 200);
  });

  window.BelfedBilling = { refresh, loadState };
})();

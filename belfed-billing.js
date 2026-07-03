// belfed-billing.js — /billing.html
//
// Three blocks: Subscription, Payment method, Payment history.
// Used by billing.html. Requires:
//   - window.supaClient (created by belfed-auth.js)
//   - User must be signed in (handled here: shows login-required if not)
//
// 2026-07-03: BelFed migrated fully off YooKassa. All active billing now
// happens through Tribute (@tribute bot). Historical YooKassa rows may still
// exist in `subscriptions` / `payments` for reference — they render, but no
// UI action calls yookassa-* edge functions anymore. Cancellation and card
// management are entirely on Tribute's side.
//
// All copy is RU only.
(function () {
  'use strict';

  const SUPABASE_URL = 'https://obujqvqqmyfcfflhqvud.supabase.co';

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

    // Subscriptions: users may have multiple rows across providers (yookassa/tribute/telegram_stars)
    // or historical rows — prefer active, otherwise fall back to the most recent by period end.
    const [{ data: prof }, { data: subs }, { data: pays }] = await Promise.all([
      c.from('profiles')
        .select('id, email, subscription_status, subscription_plan, subscription_expires_at, telegram_id, telegram_username, trial_started_at, trial_end, founding_member, founding_locale')
        .eq('id', session.user.id).maybeSingle(),
      c.from('subscriptions')
        .select('id, status, plan_code, provider, amount_rub, current_period_end, cancel_at_period_end, payment_method_id, card_last4, card_brand, payment_method_saved_at, payment_method_detached_at, failed_attempts, last_charge_error')
        .eq('user_id', session.user.id)
        .order('current_period_end', { ascending: false, nullsFirst: false })
        .limit(10),
      c.from('payments')
        .select('id, provider, amount, currency, status, paid_at, created_at, is_recurring, provider_payment_id')
        .eq('user_id', session.user.id)
        .order('created_at', { ascending: false })
        .limit(24),
    ]);
    const subsList = Array.isArray(subs) ? subs : [];
    const sub = subsList.find(s => s.status === 'active') || subsList[0] || null;
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
    // Autorenew is now always managed externally by Tribute (or, for legacy
    // rows, by whichever provider is on record). We assume ON unless the row
    // has cancel_at_period_end.
    const provider = subscription?.provider || 'tribute';
    const autorenew = isPaid && !subscription.cancel_at_period_end;

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
    // Cancellation and card management now live entirely inside Tribute.
    if (autorenew) {
      actHtml += `<a class="btn btn-secondary" href="https://t.me/tribute" target="_blank" rel="noopener">Управлять в Tribute →</a>`;
    }
    if (!isPaid && !isAdmin) {
      // Two explicit Tribute checkout channels — pick your route.
      actHtml +=
        '<a class="bill-pay-btn bill-pay-btn--primary" href="https://t.me/tribute/app?startapp=sZH9" target="_blank" rel="noopener" data-belfed-pay="tg">' +
          '<span class="bill-pay-icon" aria-hidden="true">' +
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9.78 15.27 9.6 18.9c.36 0 .52-.15.72-.34l1.72-1.64 3.56 2.6c.65.36 1.11.17 1.29-.6l2.33-10.94c.22-.99-.36-1.38-.99-1.15L4.05 10.9c-.96.37-.95.9-.16 1.14l3.8 1.18 8.82-5.56c.42-.27.8-.12.48.16z"/></svg>' +
          '</span>' +
          '<span class="bill-pay-text"><b>Оплатить через Telegram</b><small>' + fmtRub(monthlyAmount) + ' / мес · Tribute-бот</small></span>' +
        '</a>' +
        '<a class="bill-pay-btn bill-pay-btn--secondary" href="https://web.tribute.tg/s/ZH9" target="_blank" rel="noopener" data-belfed-pay="web">' +
          '<span class="bill-pay-icon" aria-hidden="true">' +
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a13.5 13.5 0 010 18M12 3a13.5 13.5 0 000 18"/></svg>' +
          '</span>' +
          '<span class="bill-pay-text"><b>Оплатить через браузер</b><small>' + fmtRub(monthlyAmount) + ' / мес · Tribute Web</small></span>' +
        '</a>';
    }
    actions.innerHTML = actHtml;

    // Fire analytics on channel picks.
    actions.querySelectorAll('[data-belfed-pay]').forEach(function (el) {
      el.addEventListener('click', function () {
        try {
          if (window.belfedTrack) {
            window.belfedTrack('payment_started', {
              plan: 'month', provider: 'tribute',
              channel: el.getAttribute('data-belfed-pay') || 'unknown', source: 'billing',
            });
          }
        } catch (_) {}
      });
    });

    if (isPaid && autorenew) {
      hint.innerHTML = `Доступ продлится автоматически <b>${fmtDate(exp)}</b>. Чтобы отменить автопродление, откройте подписку в боте <b>@tribute</b> → My subscriptions. Доступ сохранится до этой даты, дальше выключится.`;
    } else if (isPaid && !autorenew) {
      hint.innerHTML = `Автопродление отключено. Доступ сохранится до <b>${fmtDate(exp)}</b>, после чего отключится. Чтобы продолжить — оформите подписку заново.`;
    } else if (isTrial) {
      hint.innerHTML = `Карта не привязана. После окончания триала доступ завершится — подписка оформляется в Tribute по вашему действию.`;
    } else if (!isAdmin) {
      hint.innerHTML = `Подпишитесь через Tribute, чтобы получить доступ в закрытый Telegram-канал и к полной аналитике.`;
    } else {
      hint.textContent = '';
    }
  }

  function renderPaymentMethod(state) {
    // No-op: the payment-method section has been merged into the unified
    // '// Управление подпиской' card. All Tribute payment CTAs live in
    // renderSubscription() now. The three legacy DOM targets remain hidden
    // in billing.html and are intentionally not populated here.
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

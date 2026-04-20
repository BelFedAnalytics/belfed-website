// belfed-payments.js
// YooKassa payment integration for BelFed Analytics members area.
// Loaded after belfed-auth.js. Exposes window.BelfedPayments.
(function () {
  'use strict';

  var SUPABASE_URL = 'https://obujqvqqmyfcfflhqvud.supabase.co';
  var CREATE_PAYMENT_URL = SUPABASE_URL + '/functions/v1/yookassa-create-payment';
  var DEFAULT_RETURN_URL = window.location.origin + '/members.html?payment=success';

  function getSupabaseClient() {
    if (window.belfedSupabase) return window.belfedSupabase;
    if (window.supabaseClient) return window.supabaseClient;
    return null;
  }

  async function getAccessToken() {
    var client = getSupabaseClient();
    if (!client || !client.auth) throw new Error('Supabase client is not ready');
    var res = await client.auth.getSession();
    var session = res && res.data && res.data.session;
    if (!session) throw new Error('You must be signed in to pay');
    return session.access_token;
  }

  async function createPayment(opts) {
    opts = opts || {};
    var plan = opts.plan || 'month';
    var amount = opts.amount;
    var returnUrl = opts.return_url || DEFAULT_RETURN_URL;

    var token = await getAccessToken();
    var body = { plan: plan, return_url: returnUrl };
    if (amount != null) body.amount = amount;

    var resp = await fetch(CREATE_PAYMENT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify(body)
    });

    var data = null;
    try { data = await resp.json(); } catch (e) {}

    if (!resp.ok) {
      var msg = (data && (data.error || data.message)) || ('HTTP ' + resp.status);
      throw new Error(msg);
    }
    if (!data || !data.confirmation_url) {
      throw new Error('No confirmation_url in response');
    }
    return data;
  }

  async function startCheckout(opts) {
    var data = await createPayment(opts);
    window.location.assign(data.confirmation_url);
  }

  function bindButton(selector, opts) {
    var btn = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!btn) return;
    btn.addEventListener('click', async function (e) {
      e.preventDefault();
      btn.disabled = true;
      var origText = btn.textContent;
      btn.textContent = 'Redirecting...';
      try {
        await startCheckout(opts);
      } catch (err) {
        console.error('[BelfedPayments] checkout failed', err);
        alert('Payment error: ' + (err && err.message ? err.message : err));
        btn.disabled = false;
        btn.textContent = origText;
      }
    });
  }

  function handleReturn() {
    try {
      var url = new URL(window.location.href);
      if (url.searchParams.get('payment') === 'success') {
        if (typeof window.belfedRefreshProfile === 'function') {
          window.belfedRefreshProfile();
        }
      }
    } catch (e) {}
  }

  document.addEventListener('DOMContentLoaded', handleReturn);

  window.BelfedPayments = {
    createPayment: createPayment,
    startCheckout: startCheckout,
    bindButton: bindButton
  };
})();

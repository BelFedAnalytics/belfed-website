// ===========================================
// BelFed Auth — Shared Identity Module
// ===========================================
// Include AFTER supabase-js CDN script.
// Each page must define: onAuthReady(profile, session)
// and onAuthSignedOut()

var SUPABASE_URL = 'https://obujqvqqmyfcfflhqvud.supabase.co';
var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9idWpxdnFxbXlmY2ZmbGhxdnVkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzNDgxNjYsImV4cCI6MjA4OTkyNDE2Nn0.syl4YBLbf8aBitxyK3gCL51pPYxWjEW99mMTXJaQQ8w';
var supaClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
var currentProfile = null;
var currentSubscription = null;

// --- Auth UI helpers ---
function showAuthTab(tab) {
  // Activate the matching tab button without relying on a global `event`,
  // so this can also be called programmatically (e.g. from #signup hash).
  document.querySelectorAll('.auth-tab').forEach(function(b) {
    var oc = b.getAttribute('onclick') || '';
    b.classList.toggle('active', oc.indexOf("'" + tab + "'") !== -1);
  });
  var siForm = document.getElementById('signinForm');
  var suForm = document.getElementById('signupForm');
  if (siForm) siForm.style.display = tab === 'signin' ? 'block' : 'none';
  if (suForm) suForm.style.display = tab === 'signup' ? 'block' : 'none';
  var mlForm = document.getElementById('magiclinkForm'); if (mlForm) mlForm.style.display = tab === 'magiclink' ? 'block' : 'none';
  var errEl = document.getElementById('loginError'); if (errEl) errEl.style.display = 'none';
  var msgEl = document.getElementById('loginMsg'); if (msgEl) msgEl.style.display = 'none';
  var fpBlock = document.getElementById('forgotPasswordBlock');
  var fpLink = document.getElementById('forgotPasswordLink');
  if (fpBlock) fpBlock.style.display = 'none';
  if (fpLink) fpLink.style.display = 'block';
  var rs = document.getElementById('resetStatus');
  if (rs) rs.style.display = 'none';
}

// Open the correct auth tab based on the URL hash (#signup / #signin).
// Default (no/unknown hash) leaves the sign-in tab active.
function applyAuthHashTab() {
  if (!document.getElementById('signupForm')) return; // not the members page
  var h = (window.location.hash || '').replace('#', '').toLowerCase();
  if (h === 'signup') showAuthTab('signup');
  else if (h === 'signin') showAuthTab('signin');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', applyAuthHashTab);
} else {
  applyAuthHashTab();
}
window.addEventListener('hashchange', applyAuthHashTab);

// Map raw Supabase auth errors to clear Russian messages.
function ruAuthError(err, context) {
  var raw = (err && err.message ? err.message : '').toLowerCase();
  if (raw.indexOf('already registered') !== -1 || raw.indexOf('already been registered') !== -1 || raw.indexOf('user already') !== -1) {
    return 'Этот email уже зарегистрирован. Войдите в аккаунт или восстановите пароль.';
  }
  if (raw.indexOf('invalid login credentials') !== -1) {
    return 'Неверный email или пароль. Проверьте данные или восстановите пароль.';
  }
  if (raw.indexOf('email not confirmed') !== -1) {
    return 'Email не подтверждён. Проверьте почту и перейдите по ссылке из письма.';
  }
  if (raw.indexOf('invalid') !== -1 && raw.indexOf('email') !== -1) {
    return 'Некорректный email. Проверьте адрес и попробуйте снова.';
  }
  if (raw.indexOf('rate limit') !== -1 || raw.indexOf('too many') !== -1) {
    return 'Слишком много попыток. Подождите немного и попробуйте снова.';
  }
  if (raw.indexOf('password') !== -1 && raw.indexOf('least') !== -1) {
    return 'Пароль должен быть не менее 6 символов.';
  }
  return (err && err.message) ? err.message : (context === 'signin' ? 'Не удалось войти' : 'Ошибка регистрации');
}

function showLoginError(text) {
  var errEl = document.getElementById('loginError');
  if (!errEl) return;
  errEl.textContent = text;
  errEl.style.display = 'block';
  try { errEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {}
}

async function handleSignIn() {
  var email = document.getElementById('siEmail').value.trim();
  var pw = document.getElementById('siPassword').value;
  var errEl = document.getElementById('loginError');
  errEl.style.display = 'none';
  if (!email || !pw) { showLoginError('Введите email и пароль'); return; }
  var btn = document.querySelector('#signinForm .login-btn');
  var prevBtnText = null;
  if (btn) { prevBtnText = btn.textContent; btn.disabled = true; btn.textContent = 'Вход...'; }
  try {
    var res = await supaClient.auth.signInWithPassword({ email: email, password: pw });
    if (res.error) throw res.error;
  } catch (err) {
    showLoginError(ruAuthError(err, 'signin'));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = prevBtnText || 'Войти'; }
  }
}

async function handleMagicLink() {
  var email = document.getElementById('mlEmail').value.trim();
  var errEl = document.getElementById('loginError');
  var msgEl = document.getElementById('loginMsg');
  errEl.style.display = 'none';
  msgEl.style.display = 'none';
  if (!email) { errEl.textContent = 'Please enter your email'; errEl.style.display = 'block'; return; }
  try {
    var res = await supaClient.auth.signInWithOtp({
      email: email,
      options: { emailRedirectTo: window.location.origin + '/confirm.html' }
    });
    if (res.error) throw res.error;
    msgEl.textContent = 'Magic link sent! Check your email and click the link to sign in.';
    msgEl.style.display = 'block';
  } catch (err) {
    errEl.textContent = err.message || 'Failed to send magic link';
    errEl.style.display = 'block';
  }
}

// ===========================================
// BelFed Auth — Signup UX patch (RU)
// Injected into the page on DOMContentLoaded.
// Adds:
//   • consent checkbox above signup button
//   • post-signup success card with TG CTA
// ===========================================

(function () {
  // ---- Inject CSS once ----
  function injectStyles() {
    if (document.getElementById('belfed-signup-styles')) return;
    var css = ''
      + '.signup-consent{margin:14px 0 8px;font-size:12px;line-height:1.55;display:flex;align-items:flex-start;gap:8px;letter-spacing:0.02em}'
      + '.signup-consent input[type="checkbox"]{margin-top:3px;flex-shrink:0;cursor:pointer;width:14px;height:14px}'
      + '.signup-consent label{cursor:pointer;color:var(--gray,#666)}'
      + '.signup-consent a{color:inherit;text-decoration:underline;text-underline-offset:2px}'
      + '.signup-consent a:hover{color:var(--green,#1a7a1a)}'
      + '.signup-success{padding:24px 22px;border:1px solid #000;background:#fff;margin-top:18px}'
      + '.signup-success h3{margin:0 0 12px;font-size:14px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase}'
      + '.signup-success p{margin:0 0 20px;font-size:13px;line-height:1.6;color:#222}'
      + '.signup-success .cta-tg{display:block;width:100%;text-align:center;padding:16px 18px;background:#000;color:#fff;text-decoration:none;font-size:13px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;border:1px solid #000;transition:background .15s ease,color .15s ease}'
      + '.signup-success .cta-tg:hover{background:#1a7a1a;border-color:#1a7a1a;color:#fff}'
      + '.signup-success .signup-success-note{margin:14px 0 0;font-size:11px;color:var(--gray,#999);text-align:center;letter-spacing:0.04em}'
      + '.signup-success .signup-success-note a{color:inherit;text-decoration:underline}';
    var st = document.createElement('style');
    st.id = 'belfed-signup-styles';
    st.textContent = css;
    document.head.appendChild(st);
  }

  // ---- Inject consent checkbox into every signup form ----
  function injectConsent() {
    document.querySelectorAll('#signupForm').forEach(function (form) {
      if (form.querySelector('.signup-consent')) return; // already injected
      var btn = form.querySelector('.login-btn');
      if (!btn) return;
      var wrap = document.createElement('div');
      wrap.className = 'signup-consent';
      wrap.innerHTML = ''
        + '<input type="checkbox" id="suConsent">'
        + '<label for="suConsent">Я согласен с <a href="/privacy.html" target="_blank" rel="noopener">Политикой конфиденциальности</a> и <a href="/oferta.html" target="_blank" rel="noopener">Условиями использования (Офертой)</a></label>';
      form.insertBefore(wrap, btn);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { injectStyles(); injectConsent(); });
  } else {
    injectStyles();
    injectConsent();
  }
})();

// ---- New handleSignUp (overrides previous) ----
async function handleSignUp() {
  var email = document.getElementById('suEmail').value.trim();
  var pw  = document.getElementById('suPassword').value;
  var pw2 = document.getElementById('suPassword2').value;
  var consentBox = document.getElementById('suConsent');
  var errEl = document.getElementById('loginError');
  var msgEl = document.getElementById('loginMsg');
  errEl.style.display = 'none'; msgEl.style.display = 'none';
  msgEl.innerHTML = '';

  if (!email || !pw || !pw2) { showLoginError('Заполните все поля'); return; }
  if (pw !== pw2) { showLoginError('Пароли не совпадают'); return; }
  if (pw.length < 6) { showLoginError('Пароль должен быть не менее 6 символов'); return; }
  if (!consentBox || !consentBox.checked) {
    showLoginError('Нужно согласиться с Политикой конфиденциальности и Условиями использования');
    return;
  }

  // Disable form while we work
  var btn = document.querySelector('#signupForm .login-btn');
  var prevBtnText = null;
  if (btn) { prevBtnText = btn.textContent; btn.disabled = true; btn.textContent = 'Создание аккаунта...'; }

  try {
    var res = await supaClient.auth.signUp({
      email: email,
      password: pw,
      options: { emailRedirectTo: window.location.origin + '/confirm.html' }
    });
    if (res.error) throw res.error;

    // Supabase may obfuscate "already registered" by returning a user with an
    // empty identities array instead of an error. Treat that as a duplicate.
    var u = res.data && res.data.user;
    if (u && Array.isArray(u.identities) && u.identities.length === 0) {
      throw { message: 'User already registered' };
    }

    // Account created — emit funnel event with available UTM context.
    if (typeof window !== 'undefined' && window.belfedTrack) window.belfedTrack('signup_complete', { email: email });

    // Fetch one-time TG deep-link with email + consent (+ UTM attribution if available)
    var intentBody = {
      email: email,
      lang: 'ru',
      source: 'web_signup',
      accept_privacy: true,
      accept_terms: true
    };
    if (typeof window !== 'undefined' && window.belfedAnalytics) {
      intentBody = Object.assign(intentBody, window.belfedAnalytics.utmPayload());
    }
    var intentRes = await fetch(SUPABASE_URL + '/functions/v1/trial-intent-create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(intentBody)
    });
    var intentData = await intentRes.json();
    var deepLink = (intentData && intentData.ok && intentData.deep_link)
      ? intentData.deep_link
      : 'https://t.me/BelfedBot?start=trial_link';

    // Render success card
    msgEl.innerHTML = ''
      + '<div class="signup-success">'
      + '  <h3>Аккаунт создан</h3>'
      + '  <p>Чтобы активировать 7-дневный доступ к личному кабинету и получать наши сделки в живом режиме — присоединяйтесь к нашей трейдинг-группе.</p>'
      + '  <a class="cta-tg" href="' + deepLink + '" target="_blank" rel="noopener">Получить доступ к группе</a>'
      + '  <div class="signup-success-note">Ссылка одноразовая, действует 15 минут. Если что — <a href="#" onclick="document.getElementById(\'signupForm\').querySelector(\'.login-btn\').click();return false;">запросите новую</a>.</div>'
      + '</div>';
    msgEl.style.display = 'block';
    if (typeof window !== 'undefined' && window.belfedTrack) window.belfedTrack('trial_started', { source: 'web_signup' });

    // Auto-login if session already exists (shouldn't, but safe)
    if (res.data.session) {
      await checkProfile();
    }
  } catch (err) {
    // Always surface the error in the active signup tab and reset the button.
    showAuthTab('signup');
    showLoginError(ruAuthError(err, 'signup'));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = prevBtnText || 'Начать 7 дней бесплатно'; }
  }
}

async function handleForgotPassword() {
  var email = document.getElementById('resetEmail').value.trim();
  var statusEl = document.getElementById('resetStatus');
  statusEl.style.display = 'block';
  if (!email) { statusEl.textContent = 'Please enter your email'; statusEl.style.color = 'var(--red, #c50000)'; return; }
  statusEl.textContent = 'Sending reset link...'; statusEl.style.color = 'var(--gray, #999)';
  try {
    var res = await supaClient.auth.resetPasswordForEmail(email, { redirectTo: 'https://belfed.ru/reset-password.html' });
    if (res.error) throw res.error;
    statusEl.textContent = 'Reset link sent! Check your email.'; statusEl.style.color = 'var(--green, #1a7a1a)';
  } catch (err) { statusEl.textContent = err.message || 'Error sending reset link'; statusEl.style.color = 'var(--red, #c50000)'; }
}

async function handleLogout() {
  await supaClient.auth.signOut();
  currentProfile = null;
  currentSubscription = null;
  if (typeof onAuthSignedOut === 'function') onAuthSignedOut();
}

// --- Entitlement engine ---
// Determines access from subscriptions table first, falls back to profiles.subscription_status for legacy trial/admin
async function getEntitlement(uid) {
  // 1. Check subscriptions table for active paid subscription
  var subRes = await supaClient.from('subscriptions').select('*').eq('user_id', uid).in('status', ['active', 'trialing']).order('created_at', { ascending: false }).limit(1);
  if (subRes.data && subRes.data.length > 0) {
    var sub = subRes.data[0];
    if (sub.current_period_end && new Date(sub.current_period_end) > new Date()) {
      return { access: true, reason: 'subscription', status: sub.status, subscription: sub };
    }
    // Period ended but status not yet updated
    return { access: false, reason: 'subscription_expired', status: 'expired', subscription: sub };
  }
  // 2. Fallback: check profile for legacy trial/admin
  var profRes = await supaClient.from('profiles').select('*').eq('id', uid).single();
  if (profRes.error || !profRes.data) return { access: false, reason: 'no_profile', status: 'none', profile: null };
  var p = profRes.data;
  currentProfile = p;
  if (p.subscription_status === 'admin') return { access: true, reason: 'admin', status: 'admin', profile: p };
  if (p.subscription_status === 'active') return { access: true, reason: 'active', status: 'active', profile: p };
  if (p.subscription_status === 'trial') {
    if (p.trial_end && new Date(p.trial_end) > new Date()) {
      return { access: true, reason: 'trial', status: 'trial', profile: p };
    }
    // Trial expired — update server-side
    await supaClient.from('profiles').update({ subscription_status: 'expired' }).eq('id', uid);
    p.subscription_status = 'expired';
    return { access: false, reason: 'trial_expired', status: 'expired', profile: p };
  }
  return { access: false, reason: 'expired', status: p.subscription_status || 'none', profile: p };
}

async function checkProfile() {
  var sess = await supaClient.auth.getSession();
  if (!sess.data.session) {
    if (typeof onAuthSignedOut === 'function') onAuthSignedOut();
    return;
  }
  var uid = sess.data.session.user.id;
  var ent = await getEntitlement(uid);
  // Also load profile if not yet loaded
  if (!currentProfile) {
    var pr = await supaClient.from('profiles').select('*').eq('id', uid).single();
    if (pr.data) currentProfile = pr.data;
  }
  currentSubscription = ent.subscription || null;
  if (typeof onAuthReady === 'function') onAuthReady(currentProfile, sess.data.session, ent);
}

async function checkAuth() {
  var hash = window.location.hash;
  if (hash && hash.includes('access_token')) {
    var params = new URLSearchParams(hash.substring(1));
    var at = params.get('access_token');
    var rt = params.get('refresh_token');
    if (at && rt) {
      await supaClient.auth.setSession({ access_token: at, refresh_token: rt });
      window.location.hash = '';
    }
  }
  var sess = await supaClient.auth.getSession();
  if (sess.data.session) { await checkProfile(); }
  else { if (typeof onAuthSignedOut === 'function') onAuthSignedOut(); }
}

supaClient.auth.onAuthStateChange(function(event, session) {
  if (event === 'SIGNED_IN' && session) { checkProfile(); }
  if (event === 'SIGNED_OUT') {
    currentProfile = null;
    currentSubscription = null;
    if (typeof onAuthSignedOut === 'function') onAuthSignedOut();
  }
});

checkAuth();

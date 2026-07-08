/* BelFed trade-review modal layer (russian mirror, belfed.ru).
 *
 * Adds a per-trade "Обзор" button to the "Анализ" column of the existing
 * results pages (ru/trades.html и ru/equities.html) and opens an accessible
 * modal card for that trade. Nothing else on the page changes.
 *
 * Card algorithm (identical to the approved preview):
 *   - Trade found in the static manifest (trade_review_cards.json):
 *       bot trades  -> rich timeline card (muted intro, verbatim messages,
 *                      per-step locked subscriber-signal labels, promo CTA).
 *       other trades-> legacy card (Исходный анализ pill, ledger fields,
 *                      follow-up comments if any, muted methodology, promo CTA).
 *   - Trade NOT in the manifest (e.g. just closed, export not regenerated yet):
 *       a legacy card is built here from the row's own visible fields. No
 *       fabricated timeline.
 *
 * This mirror is russian-only: the manifest ships {kind, ru} per entry and all
 * UI/fallback copy below is russian. No machine translation.
 *
 * No storage APIs are used (no localStorage / sessionStorage / cookies).
 */
(function () {
  "use strict";

  var LANG = "ru";
  var MANIFEST_URL = "trade_review_cards.json";
  var TRIAL_HREF = "/ru/trial.html?source=trial_tradehistory_modal_ru";

  // Russian UI + fallback-card copy (verbatim from the approved preview).
  var T = {
    review: "Обзор",
    reviewAria: "Открыть анализ для",
    close: "Закрыть",
    origLink: "Исходный анализ",
    note: "Дополнительные комментарии",
    f: { dir: "Направление", result: "Результат", opened: "Открыта",
         closed: "Закрыта", entry: "Вход", exit: "Выход" },
    dir: { long: "Длинная", short: "Короткая" },
    methodHeading: "Методология",
    methodBullets: [
      "Этот обзор относится к публичной торговой идее и анализу, опубликованным в социальных каналах BelFed.",
      "В исходном посте были описаны контекст тренда, рабочий сценарий на ближайшие недели и ключевые зоны поддержки/сопротивления, за которыми мы следили.",
      "Если отдельно публиковались комментарии об открытии позиции, частичной фиксации прибыли или полном закрытии, мы используем эти комментарии как сигналы открытия и закрытия позиции.",
      "Если комментария по исполнению нет, позиция учитывается только при удержании цены вблизи отмеченной зоны консолидации и дальнейшем движении к целевой зоне поддержки/сопротивления. Риск считается от нижней границы зоны поддержки или предыдущего локального минимума; если консолидация выходит за отмеченные уровни поддержки/сопротивления, идея считается убытком в 1R.",
    ],
    promoH: "Следите за BelFed в реальном времени",
    promoBody: "Оформите 14-дневный тестовый доступ, чтобы получать торговые идеи, обновления по позициям и риск-комментарии по мере публикации.",
    promoBtn: "Начать 14-дневный тест",
  };

  var ARROW = "↗"; // ↗

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // DD.MM.YYYY (or already ISO) -> YYYY-MM-DD, else "".
  function toISO(d) {
    d = (d || "").trim();
    if (!d) return "";
    var m = d.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) return m[3] + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0");
    var i = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return i ? i[1] + "-" + i[2] + "-" + i[3] : "";
  }

  function keyFor(data) {
    var t = (data.ticker || "").toUpperCase();
    return {
      full: t + "|" + toISO(data.entryDate) + "|" + toISO(data.exitDate),
      pair: t + "|" + toISO(data.entryDate),
    };
  }

  // Fallback legacy card for trades not present in the manifest. No fake timeline.
  function fallbackCard(data) {
    var dirKey = (data.dir || "").toLowerCase();
    var dirLabel = T.dir[dirKey] || data.dir || "—";
    var badgeCls = dirKey === "short" ? "badge-short" : "badge-long";
    var rVal = parseFloat(String(data.result || "").replace(",", ".").replace("R", ""));
    var rCls = isNaN(rVal) ? "" : (rVal > 0 ? "win" : "loss");
    var resultHTML = data.result
      ? '<span class="' + rCls + '">' + esc(data.result) + "</span>"
      : '<span class="no-link">—</span>';

    function field(k, v) {
      return '<div class="field"><span class="field-k">' + esc(k) +
             '</span><span class="field-v">' + v + "</span></div>";
    }
    var fields =
      field(T.f.dir, '<span class="badge ' + badgeCls + '">' + esc(dirLabel) + "</span>") +
      field(T.f.result, resultHTML) +
      field(T.f.opened, esc(data.entryDate || "—")) +
      field(T.f.closed, esc(data.exitDate || "—")) +
      field(T.f.entry, esc(data.entryP || "—")) +
      field(T.f.exit, esc(data.exitP || "—"));

    var link = "";
    if (data.tvLink && /^https?:\/\//.test(data.tvLink)) {
      link = '<a class="orig-cta" href="' + esc(data.tvLink) + '" target="_blank" ' +
             'rel="noopener">' + esc(T.origLink) + " " + ARROW + "</a>";
    }
    var bullets = T.methodBullets.map(function (b) { return "<li>" + esc(b) + "</li>"; }).join("");
    var method = '<div class="rc-method"><span class="rc-method-h">' + esc(T.methodHeading) +
                 "</span><ul>" + bullets + "</ul></div>";
    return '<article class="card card-legacy">' +
           '<div class="card-head"><span class="ticker">' + esc(data.ticker) + "</span></div>" +
           link + '<div class="fields">' + fields + "</div>" + method + promoHTML() + "</article>";
  }

  function promoHTML() {
    return '<div class="promo"><span class="promo-h">' + esc(T.promoH) + "</span>" +
           '<p class="promo-body">' + esc(T.promoBody) + "</p>" +
           '<a class="promo-btn" href="' + esc(TRIAL_HREF) + '" data-cta="trial">' +
           esc(T.promoBtn) + " " + ARROW + "</a></div>";
  }

  // --- manifest (lazy, cached) ---
  var manifestPromise = null;
  function getManifest() {
    if (!manifestPromise) {
      manifestPromise = fetch(MANIFEST_URL)
        .then(function (r) { return r.ok ? r.json() : {}; })
        .catch(function () { return {}; });
    }
    return manifestPromise;
  }

  // --- overlay ---
  var overlay, box, bodyEl, titleEl, closeBtn, lastFocused = null;

  function buildOverlay() {
    overlay = document.createElement("div");
    overlay.className = "brc-overlay";
    overlay.id = "brc-modal";
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="brc-box" role="dialog" aria-modal="true" aria-labelledby="brc-title">' +
        '<div class="brc-bar">' +
          '<h2 id="brc-title" class="brc-title"></h2>' +
          '<button class="brc-close" type="button" aria-label="' + esc(T.close) + '">✕</button>' +
        "</div>" +
        '<div class="brc-body"></div>' +
      "</div>";
    document.body.appendChild(overlay);
    box = overlay.querySelector(".brc-box");
    bodyEl = overlay.querySelector(".brc-body");
    titleEl = overlay.querySelector(".brc-title");
    closeBtn = overlay.querySelector(".brc-close");
    closeBtn.addEventListener("click", close);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    document.addEventListener("keydown", onKeydown);
  }

  function focusables() {
    return Array.prototype.filter.call(
      box.querySelectorAll('a[href],button,[tabindex]:not([tabindex="-1"])'),
      function (el) { return !el.hasAttribute("disabled") && el.offsetParent !== null; });
  }

  function onKeydown(e) {
    if (overlay.hidden) return;
    if (e.key === "Escape") { close(); return; }
    if (e.key === "Tab") {
      var f = focusables(); if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  function open(trigger, html, title) {
    lastFocused = trigger;
    bodyEl.innerHTML = html;
    titleEl.textContent = title || "";
    overlay.hidden = false;
    document.body.style.overflow = "hidden";
    closeBtn.focus();
  }

  function close() {
    if (overlay.hidden) return;
    overlay.hidden = true;
    bodyEl.innerHTML = "";
    document.body.style.overflow = "";
    if (lastFocused && lastFocused.focus) lastFocused.focus();
    lastFocused = null;
  }

  function openFor(trigger) {
    var data = JSON.parse(trigger.getAttribute("data-brc") || "{}");
    var title = (data.ticker || "") + " · " + T.review;
    var k = keyFor(data);
    getManifest().then(function (m) {
      var entry = m[k.full] || m[k.pair];
      var html = entry && entry[LANG] ? entry[LANG] : fallbackCard(data);
      open(trigger, html, title);
    });
  }

  /* Public: add a Review button to a trade's Analysis cell.
     data = {ticker,dir,entryDate,exitDate,entryP,exitP,result,tvLink} */
  function attachButton(cell, data) {
    if (!cell || cell.querySelector(".brc-review-btn")) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "brc-review-btn";
    btn.textContent = T.review;
    btn.setAttribute("aria-haspopup", "dialog");
    btn.setAttribute("aria-label", T.reviewAria + " " + (data.ticker || ""));
    btn.setAttribute("data-brc", JSON.stringify(data));
    btn.addEventListener("click", function () { openFor(btn); });
    cell.appendChild(btn);
  }

  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }
  ready(buildOverlay);

  window.BelfedReview = { attachButton: attachButton, lang: LANG };
})();

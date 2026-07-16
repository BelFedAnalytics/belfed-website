/* BelFed trade-review modal layer.
 *
 * Adds a per-trade "Review / Обзор" button to the Analysis column of the existing
 * results pages (trades.html, equities-trades.html, and the belfed.ru mirror) and
 * opens an accessible modal card for that trade. Nothing else on the page changes.
 *
 * Card algorithm (identical to the approved preview):
 *   - Trade found in the static manifest (trade_review_cards.json):
 *       bot trades  -> rich timeline card (muted intro, verbatim messages,
 *                      per-step locked subscriber-signal labels, promo CTA).
 *       other trades-> legacy card (Original Analysis pill, ledger fields,
 *                      follow-up comments if any, muted methodology, promo CTA).
 *   - Trade NOT in the manifest (e.g. just closed, export not regenerated yet):
 *       a legacy card is built here from the row's own visible fields — Original
 *       Analysis pill (from the row's TradingView link), ledger fields, muted
 *       methodology, promo CTA. No fabricated timeline.
 *
 * Language: belfed.ru -> Russian, otherwise English. No machine translation; the
 * manifest already routes source comments by detected content language.
 *
 * No storage APIs are used (no localStorage / sessionStorage / cookies).
 */
(function () {
  "use strict";

  var LANG = (function () {
    try {
      var h = (location.hostname || "").toLowerCase();
      if (h === "belfed.ru" || h.indexOf(".ru") === h.length - 3) return "ru";
    } catch (e) {}
    var d = (document.documentElement.getAttribute("lang") || "").toLowerCase();
    return d.indexOf("ru") === 0 ? "ru" : "en";
  })();

  var MANIFEST_URL = "trade_review_cards.json";
  var TRIAL_HREF = "/trial.html?source=trial_tradehistory_modal_" + LANG;

  // Localized UI + fallback-card copy (verbatim from the approved preview).
  var T = {
    en: {
      review: "Review",
      reviewAria: "Open analysis for",
      close: "Close",
      origLink: "Original Analysis",
      note: "Follow-up comments",
      f: { dir: "Direction", result: "Result", opened: "Entry Date",
           closed: "Exit Date", entry: "Entry $", exit: "Exit $" },
      dir: { long: "Long", short: "Short" },
      methodHeading: "Methodology note",
      methodBullets: [
        "This review refers to a public trade idea and analysis originally published through BelFed's social channels.",
        "The original post outlined the trend context, the working scenario for the coming weeks, and the key support/resistance zones we were watching.",
        "When separate public comments on opening, partial profit-taking, or full closure were published, those comments are used as the position's opening and closing signals.",
        "If no execution comment is available, the position is counted only if price held near the marked consolidation area and then continued toward the target support/resistance zone. Risk is measured from the lower boundary of support or the previous local low; if consolidation breaks beyond the marked support/resistance levels, the idea is counted as a 1R loss.",
      ],
      promoH: "Follow BelFed in real time",
      promoBody: "Start a 14-day trial to receive trade ideas, position updates, and risk notes as they are published.",
      promoBtn: "Start 14-day trial",
    },
    ru: {
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
    },
  }[LANG];

  var ARROW = "↗"; // ↗
  // Bar-replay affordance: a small play glyph echoing TradingView's replay control.
  var PLAY_SVG = '<svg viewBox="0 0 12 12" width="11" height="11" fill="currentColor" aria-hidden="true">' +
                 '<path d="M3 2.2v7.6a.5.5 0 0 0 .77.42l6-3.8a.5.5 0 0 0 0-.84l-6-3.8A.5.5 0 0 0 3 2.2Z"/></svg>';
  var CHART_CTA = { en: "See Bar Replay at TradingView", ru: "Открыть Bar Replay в TradingView" }[LANG];
  var CHART_CAP = { en: "Published on TradingView", ru: "Опубликовано в TradingView" }[LANG];
  var LINK_WORD = { en: "link", ru: "ссылка" }[LANG];

  // Replace a bare URL with a compact inline "link ↗" anchor. Trailing
  // punctuation is kept outside the anchor so surrounding prose reads cleanly.
  function linkTag(url) {
    return '<a class="brc-inline-link" href="' + esc(url) + '" target="_blank" rel="noopener">' +
           esc(LINK_WORD) + " " + ARROW + "</a>";
  }

  // Inside every .step-body, swap raw http(s) URLs (TradingView or Telegram) for
  // the tidy "link" anchor. Leaves the rest of the verbatim message untouched.
  function linkifyStepBodies(cardHTML) {
    return cardHTML.replace(/(<div class="step-body">)([\s\S]*?)(<\/div>)/g,
      function (_m, open, body, close) {
        var out = body.replace(/(https?:\/\/[^\s<)\]]+)([)\].,;:!?]*)(?=\s|$)/g,
          function (_all, url, trail) {
            var u = url.replace(/[.,;:!?]+$/, "");
            var extra = url.slice(u.length) + trail;
            return linkTag(u) + extra;
          });
        return open + out + close;
      });
  }

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

  // Derive the S3 snapshot image URL for a TradingView idea/share link.
  //   /x/{CODE}/            -> https://s3.tradingview.com/snapshots/{c0}/{CODE}.png
  //   /chart/.../{CODE}-slug -> https://s3.tradingview.com/{c0}/{CODE}_big.png
  function deriveSnapshot(tvLink) {
    var u = String(tvLink || "");
    var m = u.match(/tradingview\.com\/x\/([A-Za-z0-9]+)/);
    if (m) { var c = m[1]; return "https://s3.tradingview.com/snapshots/" + c.charAt(0).toLowerCase() + "/" + c + ".png"; }
    m = u.match(/tradingview\.com\/chart\/[^\/]+\/([A-Za-z0-9]+)-/);
    if (m) { var c2 = m[1]; return "https://s3.tradingview.com/" + c2.charAt(0).toLowerCase() + "/" + c2 + "_big.png"; }
    return "";
  }

  // Chart <figure> for the top of the card. Prefer the sheet's pre-resolved
  // snapshot URL (col AA), else derive from the TradingView link. Hides itself
  // gracefully if the image fails to load.
  function chartHTML(data) {
    var src = (data.snap && /^https?:\/\//.test(data.snap)) ? data.snap.trim() : deriveSnapshot(data.tvLink);
    if (!src) return "";
    var cap;
    if (data.tvLink && /^https?:\/\//.test(data.tvLink)) {
      cap = '<figcaption><a class="brc-chart-cta" href="' + esc(data.tvLink) + '" target="_blank" rel="noopener">' +
            PLAY_SVG + "<span>" + esc(CHART_CTA) + "</span> " + ARROW + "</a></figcaption>";
    } else {
      cap = '<figcaption><span class="brc-chart-plain">' + esc(CHART_CAP) + "</span></figcaption>";
    }
    return '<figure class="brc-chart">' +
           '<img src="' + esc(src) + '" alt="' + esc((data.ticker || "") + " chart") + '" loading="lazy" ' +
           'onerror="var f=this.closest(&quot;.brc-chart&quot;);if(f)f.style.display=&quot;none&quot;;">' +
           cap + "</figure>";
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

    // Original-analysis link. Suppress it when a chart is shown, because the
    // chart's caption CTA already links to the same TradingView page — two
    // adjacent links to the identical page is redundant.
    var link = "";
    var hasChart = !!chartHTML(data);
    if (data.tvLink && /^https?:\/\//.test(data.tvLink) && !hasChart) {
      link = '<a class="orig-cta" href="' + esc(data.tvLink) + '" target="_blank" ' +
             'rel="noopener">' + esc(T.origLink) + " " + ARROW + "</a>";
    }
    var bullets = T.methodBullets.map(function (b) { return "<li>" + esc(b) + "</li>"; }).join("");
    var method = '<div class="rc-method"><span class="rc-method-h">' + esc(T.methodHeading) +
                 "</span><ul>" + bullets + "</ul></div>";
    return '<article class="card card-legacy">' +
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

  // Normalise a manifest card's HTML so bot and legacy cards obey the same
  // display rules as freshly-built fallback cards:
  //   - drop the ticker name under the chart (card-head ticker span)
  //   - when a chart is shown, drop the redundant "Original Analysis" link
  //     (the chart caption already links to the same TradingView page)
  //   - ensure an explicit Exit price is shown (legacy manifest cards list
  //     Stop instead of Exit); adds it to the fields block if missing.
  // Idempotent: safe on cards already transformed at manifest-build time.
  function postProcessCard(cardHTML, data, hasChart) {
    // 1. remove ticker span
    cardHTML = cardHTML.replace(/<span class="ticker">[\s\S]*?<\/span>/, "");
    // 2. remove redundant Original Analysis link when a chart is present
    if (hasChart) {
      cardHTML = cardHTML.replace(/<a class="orig-cta"[\s\S]*?<\/a>/, "");
    }
    // 3. ensure Exit price field (legacy cards). Skip if already present.
    if (data.exitP && cardHTML.indexOf("brc-exit") === -1 &&
        cardHTML.indexOf("card-legacy") !== -1 && /<div class="fields">/.test(cardHTML)) {
      var exitField = '<div class="field brc-exit"><span class="field-k">' + esc(T.f.exit) +
                      '</span><span class="field-v">' + esc(data.exitP) + "</span></div>";
      cardHTML = cardHTML.replace(/(<div class="fields">)([\s\S]*?)(<\/div>)(\s*<div class="rc-method")/,
        function (_m, open, inner, closeDiv, tail) { return open + inner + exitField + closeDiv + tail; });
    }
    // 4. tidy raw URLs inside verbatim step messages into a "link" anchor.
    cardHTML = linkifyStepBodies(cardHTML);
    return cardHTML;
  }

  function openFor(trigger) {
    var data = JSON.parse(trigger.getAttribute("data-brc") || "{}");
    var title = (data.ticker || "") + " — " + T.review;
    var k = keyFor(data);
    getManifest().then(function (m) {
      var entry = m[k.full] || m[k.pair];
      var chart = chartHTML(data);
      var card;
      if (entry && entry[LANG]) {
        card = postProcessCard(entry[LANG], data, !!chart);
      } else {
        card = fallbackCard(data);
      }
      // Prepend the embedded chart snapshot to every card (manifest or fallback).
      var html = chart + card;
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

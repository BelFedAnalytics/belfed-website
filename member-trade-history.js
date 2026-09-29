/* BelFed member trade history cards (dashboard only).
 *
 * Adds a "History / История" button to rows of the member dashboard tables
 * (open positions, opened this week, closed this week) and opens a card with
 * the full lifecycle of that position: every published message verbatim,
 * the chart at the time of each operation and a link to the original
 * Telegram message.
 *
 * Data comes live from the member-only RPC public.member_position_history()
 * (requires an active subscription, trial or admin). Nothing is cached in
 * public files. No storage APIs are used.
 */
(function () {
  "use strict";

  var LANG = (function () {
    try {
      var h = (location.hostname || "").toLowerCase();
      if (h === "belfed.ru" || /\.ru$/.test(h)) return "ru";
    } catch (e) {}
    var d = (document.documentElement.getAttribute("lang") || "").toLowerCase();
    return d.indexOf("ru") === 0 ? "ru" : "en";
  })();

  var TG = {
    ru: { chat: "3773738299", topic: "4", midKey: "message_id_ru" },
    en: { chat: "3869302680", topic: "6", midKey: "message_id_en" }
  }[LANG];

  var T = {
    ru: {
      btn: "История", btnAria: "История сделки", close: "Закрыть",
      title: function (tk) { return "История сделки " + tk; },
      long: "Long", short: "Short",
      st: { open: "Открыта", partial: "Частично закрыта", closed: "Закрыта" },
      opened: "Открытие", added: "Добавление", stopMoved: "Перенос стопа", stopHit: "Стоп сработал",
      closedLbl: "Полное закрытие", partialLbl: "Частичное закрытие",
      target: function (n) { return "Цель " + n + " достигнута"; },
      fOpened: function (p, s, tg) { return "Вход по " + p + (s ? ". Стоп " + s : "") + (tg ? ". Цели: " + tg : "") + "."; },
      fStop: function (o, n) { return "Стоп перенесён" + (o ? " с " + o : "") + (n ? " на " + n : "") + "."; },
      fStopHit: function (p) { return "Стоп сработал" + (p ? " по " + p : "") + "."; },
      fTarget: function (n, p) { return "Цель " + n + " достигнута" + (p ? " по " + p : "") + "."; },
      fPartial: function (pct, p, r) { return "Закрыто " + pct + "%" + (p ? " по " + p : "") + (r ? " (" + r + ")" : "") + "."; },
      fClosed: function (p) { return "Позиция закрыта" + (p ? " по " + p : "") + "."; },
      entry: "Вход", stop: "Стоп", initStop: "Исходный стоп", targets: "Цели", remaining: "Остаток",
      realized: "Зафиксировано", result: "Результат", openedAt: "Дата входа", closedAt: "Дата выхода",
      entryChart: "График на момент входа", stepChart: "График на момент операции",
      tgLink: "Сообщение в Telegram", comment: "Комментарий",
      intro: "Все этапы сделки: сообщения из группы участников, графики и ссылки на исходные посты в Telegram.",
      empty: "Событий по сделке пока нет.",
      loading: "Загружаем историю...", fail: "Не удалось загрузить историю. Обновите страницу."
    },
    en: {
      btn: "History", btnAria: "Trade history", close: "Close",
      title: function (tk) { return tk + " trade history"; },
      long: "Long", short: "Short",
      st: { open: "Open", partial: "Partially closed", closed: "Closed" },
      opened: "Opened", added: "Added", stopMoved: "Stop moved", stopHit: "Stop hit",
      closedLbl: "Closed", partialLbl: "Partial close",
      target: function (n) { return "Target " + n + " hit"; },
      fOpened: function (p, s, tg) { return "Entry at " + p + (s ? ". Stop " + s : "") + (tg ? ". Targets: " + tg : "") + "."; },
      fStop: function (o, n) { return "Stop moved" + (o ? " from " + o : "") + (n ? " to " + n : "") + "."; },
      fStopHit: function (p) { return "Stop hit" + (p ? " at " + p : "") + "."; },
      fTarget: function (n, p) { return "Target " + n + " reached" + (p ? " at " + p : "") + "."; },
      fPartial: function (pct, p, r) { return "Closed " + pct + "%" + (p ? " at " + p : "") + (r ? " (" + r + ")" : "") + "."; },
      fClosed: function (p) { return "Position closed" + (p ? " at " + p : "") + "."; },
      entry: "Entry", stop: "Stop", initStop: "Initial stop", targets: "Targets", remaining: "Remaining",
      realized: "Realized", result: "Result", openedAt: "Entry date", closedAt: "Exit date",
      entryChart: "Chart at entry", stepChart: "Chart at the time of this update",
      tgLink: "Message in Telegram", comment: "Comment",
      intro: "Every stage of the trade: messages from the members group, charts and links to the original Telegram posts.",
      empty: "No events on this trade yet.",
      loading: "Loading history...", fail: "Could not load the history. Please refresh the page."
    }
  }[LANG];

  // ------------------------------------------------------------------ utils
  function trim(s) { return s == null ? "" : String(s).trim(); }
  function esc(s) {
    return trim(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function num(x) {
    if (x == null || x === "") return NaN;
    return typeof x === "number" ? x : parseFloat(String(x).replace(",", "."));
  }
  function fmtNum(x) {
    var n = num(x);
    if (isNaN(n)) return "";
    var s = String(n);
    if (s.indexOf("e") >= 0) s = n.toFixed(10);
    if (s.indexOf(".") >= 0) s = s.replace(/\.?0+$/, "");
    return s;
  }
  function fmtR(x) {
    var n = num(x);
    if (isNaN(n)) return "";
    return (n >= 0 ? "+" : "") + n.toFixed(2) + "R";
  }
  function isSystem(c) { var v = trim(c); return /^(auto |corrected )/i.test(v) || /\(per sheet recap\)/i.test(v); }
  function httpsOnly(u) { var v = trim(u); return /^https:\/\/\S+$/i.test(v) ? v : ""; }
  function chartImg(url) {
    var m = String(url || "").match(/tradingview\.com\/x\/([A-Za-z0-9]+)/);
    if (!m) return "";
    return "https://s3.tradingview.com/snapshots/" + m[1].charAt(0).toLowerCase() + "/" + m[1] + ".png";
  }
  var MSK = "Europe/Moscow";
  function parts(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return null;
    var o = {};
    new Intl.DateTimeFormat("en-GB", { timeZone: MSK, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d)
      .forEach(function (p) { o[p.type] = p.value; });
    return o;
  }
  function fmtDate(ts) { var o = parts(ts); return o ? o.day + "." + o.month + "." + o.year : ""; }
  function fmtDateTime(ts) { var o = parts(ts); return o ? o.day + "." + o.month + "." + o.year + " " + o.hour + ":" + o.minute + " MSK" : ""; }
  function isoMsk(ts) { var o = parts(ts); return o ? o.year + "-" + o.month + "-" + o.day : ""; }
  function isoSheet(s) {
    var m = trim(s).match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
    if (!m) return "";
    var y = m[3].length === 2 ? "20" + m[3] : m[3];
    return y + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0");
  }
  function dirOf(s) { return /short/i.test(trim(s)) ? "short" : "long"; }
  function assetOfTab() { return window.currentTab === "crypto" ? "crypto" : "stock"; }
  function tgHref(mid) {
    var id = trim(mid);
    return /^\d+$/.test(id) ? "https://t.me/c/" + TG.chat + "/" + TG.topic + "/" + id : "";
  }

  // Stored message text: drop the chart line (the chart is shown as an image)
  // and the hashtag line; keep everything else verbatim.
  function cleanText(t) {
    var lines = trim(t).split(/\r?\n/).filter(function (ln) {
      var s = ln.trim();
      if (/^(🖼|📊|📋)/u.test(s)) return false;
      if (s && /^(#[\p{L}\p{N}_]+\s*)+$/u.test(s)) return false;
      return true;
    });
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  function linkify(escaped) {
    return escaped.replace(/(https:\/\/[^\s<]+?)([.,;:!?)]*)(?=\s|$)/g, function (_a, url, tail) {
      return '<a href="' + url + '" target="_blank" rel="noopener">' + url + "</a>" + tail;
    });
  }

  // ------------------------------------------------------------------ data
  var dataPromise = null;
  var positions = [];
  function load() {
    if (dataPromise) return dataPromise;
    dataPromise = new Promise(function (resolve) {
      var tries = 0;
      (function wait() {
        var c = window.supaClient;
        if (!c || !c.rpc) { if (++tries < 60) return setTimeout(wait, 250); return resolve(null); }
        c.auth.getSession().then(function (s) {
          if (!s || !s.data || !s.data.session) {
            if (++tries < 60) return setTimeout(wait, 500);
            return resolve(null);
          }
          c.rpc("member_position_history").then(function (res) {
            if (res.error || !res.data) { console.warn("[BFD history]", res.error); return resolve(null); }
            positions = res.data.positions || [];
            resolve(positions);
          }, function (err) { console.warn("[BFD history]", err); resolve(null); });
        });
      })();
    });
    return dataPromise;
  }

  // Match a dashboard row to a position. Primary key: asset|ticker|direction|date
  // (entry date for open rows, exit date for closed rows). Fallback: the only
  // candidate with the same asset|ticker|direction in the same state.
  function findPosition(ticker, dir, dateStr, closed) {
    var asset = assetOfTab();
    var tk = trim(ticker).toUpperCase();
    var d = dirOf(dir);
    var iso = isoSheet(dateStr);
    var cands = positions.filter(function (p) {
      if (trim(p.asset_class).toLowerCase() !== asset) return false;
      if (trim(p.ticker).toUpperCase() !== tk) return false;
      if (dirOf(p.direction) !== d) return false;
      return closed ? p.status === "closed" : p.status !== "closed";
    });
    var exact = cands.filter(function (p) { return isoMsk(closed ? p.closed_at : p.opened_at) === iso; });
    if (exact.length === 1) return exact[0];
    if (!exact.length && cands.length === 1) return cands[0];
    return exact[0] || null;
  }

  // ------------------------------------------------------------------ card
  function stepBody(text, fallback, comment) {
    var t = cleanText(text);
    if (t) return '<div class="mth-msg">' + linkify(esc(t)) + "</div>";
    var h = '<div class="mth-msg">' + esc(fallback);
    if (trim(comment)) h += "\n\n" + esc(T.comment) + ": " + esc(comment);
    return linkify(h) + "</div>";
  }

  function chartBlock(url, cap) {
    var u = httpsOnly(url);
    if (!u) return "";
    var img = chartImg(u);
    if (!img) return '<a class="mth-link" href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(cap) + " ↗</a>";
    return '<a class="mth-chart" href="' + esc(u) + '" target="_blank" rel="noopener">' +
      '<img src="' + esc(img) + '" alt="' + esc(cap) + '" loading="lazy" ' +
      'onerror="this.parentNode.style.display=\'none\'"><span>' + esc(cap) + " ↗</span></a>";
  }

  function buildSteps(p) {
    var ck = "comment_" + LANG;
    var tk = "text_" + LANG;
    var steps = [];
    var pcById = {};
    (p.partial_closes || []).forEach(function (pc) { pcById[pc.id] = pc; });
    var usedPc = {};
    var pcQueue = (p.partial_closes || []).slice();
    // Monitor-generated tranche records ("Auto target_1_hit", "Auto stop_hit")
    // belong to the matching level event: attach the closed % and R to it.
    function autoPc(e) {
      var best = null, bestDt = 1e15, t0 = new Date(e.triggered_at).getTime();
      (p.partial_closes || []).forEach(function (pc) {
        if (usedPc[pc.id]) return;
        var c = trim(pc.comment_en).toLowerCase();
        if (c !== "auto " + e.event_type) return;
        var dt = Math.abs(new Date(pc.closed_at).getTime() - t0);
        if (dt < bestDt) { best = pc; bestDt = dt; }
      });
      if (!best || bestDt > 15 * 60 * 1000) return "";
      usedPc[best.id] = true;
      return " " + T.fPartial(Math.round(num(best.pct_closed)), "", fmtR(best.r_result));
    }
    var targets = [p.target_1, p.target_2, p.target_3].map(fmtNum).filter(Boolean).join(" / ");

    (p.events || []).forEach(function (e) {
      var price = fmtNum(e.triggered_price);
      var lbl, fb = "", cm = trim(e[ck]);
      var chart = httpsOnly(e.chart_url);
      switch (e.event_type) {
        case "opened":
          lbl = e.is_addon ? T.added : T.opened;
          fb = T.fOpened(price || fmtNum(p.entry_price), fmtNum(p.initial_stop_price), targets);
          cm = cm || trim(p[ck]);
          if (chart === httpsOnly(p.tradingview_url)) chart = "";
          break;
        case "stop_moved":
          lbl = T.stopMoved; fb = T.fStop(fmtNum(e.old_stop), fmtNum(e.new_stop)); break;
        case "stop_hit":
          lbl = T.stopHit; fb = T.fStopHit(price) + autoPc(e); break;
        case "target_1_hit": lbl = T.target(1); fb = T.fTarget(1, price) + autoPc(e); break;
        case "target_2_hit": lbl = T.target(2); fb = T.fTarget(2, price) + autoPc(e); break;
        case "target_3_hit": lbl = T.target(3); fb = T.fTarget(3, price) + autoPc(e); break;
        case "partial_closed": {
          lbl = T.partialLbl;
          var pc = (e.partial_close_id != null && pcById[e.partial_close_id]) ? pcById[e.partial_close_id] : null;
          if (!pc) {
            while (pcQueue.length && (usedPc[pcQueue[0].id] || isSystem(pcQueue[0].comment_en))) pcQueue.shift();
            pc = pcQueue.shift() || null;
          }
          if (pc) {
            usedPc[pc.id] = true;
            fb = T.fPartial(Math.round(num(pc.pct_closed)), fmtNum(pc.exit_price), fmtR(pc.r_result));
            cm = cm || trim(pc[ck]);
            if (!chart) chart = httpsOnly(pc.chart_url);
          } else {
            fb = T.fPartial("", price, "");
          }
          break;
        }
        case "closed":
          lbl = T.closedLbl; fb = T.fClosed(price || fmtNum(p.exit_price)); cm = cm || trim(p["close_comment_" + LANG]); break;
        default:
          if (/^partial_stop_\d+_hit$/.test(e.event_type)) { lbl = T.stopHit; fb = T.fStopHit(price) + autoPc(e); break; }
          return;
      }
      steps.push({ ts: e.triggered_at, lbl: lbl, body: stepBody(e[tk], fb, cm), chart: chart, mid: e[TG.midKey] });
    });

    // Partial closes recorded without a published event (e.g. from the sheet).
    (p.partial_closes || []).forEach(function (pc) {
      if (usedPc[pc.id] || isSystem(pc.comment_en)) return;
      steps.push({
        ts: pc.closed_at, lbl: T.partialLbl,
        body: stepBody("", T.fPartial(Math.round(num(pc.pct_closed)), fmtNum(pc.exit_price), fmtR(pc.r_result)), pc[ck]),
        chart: httpsOnly(pc.chart_url), mid: null
      });
    });
    steps.sort(function (a, b) { return new Date(a.ts) - new Date(b.ts); });
    return steps;
  }

  function renderCard(p) {
    var d = dirOf(p.direction);
    var status = p.status === "closed" ? "closed" : (p.status === "open" ? "open" : "partial");
    var rVal = status === "closed" ? p.result_rr : p.realized_r;
    var rStr = fmtR(rVal);
    var rCls = num(rVal) >= 0 ? "mth-win" : "mth-loss";

    var head = '<div class="mth-head"><span class="mth-ticker">' + esc(p.ticker) + "</span>" +
      '<span class="mth-badge mth-' + d + '">' + esc(d === "short" ? T.short : T.long) + "</span>" +
      '<span class="mth-status">' + esc(T.st[status]) + "</span>" +
      (rStr && (status === "closed" || num(rVal) !== 0)
        ? '<span class="mth-r ' + rCls + '">' + (status === "closed" ? "" : esc(T.realized) + " ") + esc(rStr) + "</span>" : "") +
      "</div>";

    var fields = [];
    function f(k, v) { if (v) fields.push('<div class="mth-f"><span>' + esc(k) + "</span><b>" + esc(v) + "</b></div>"); }
    f(T.openedAt, fmtDate(p.opened_at));
    if (status === "closed") f(T.closedAt, fmtDate(p.closed_at));
    f(T.entry, fmtNum(p.entry_price));
    f(T.initStop, fmtNum(p.initial_stop_price));
    if (status !== "closed" && fmtNum(p.stop_price) !== fmtNum(p.initial_stop_price)) f(T.stop, fmtNum(p.stop_price));
    f(T.targets, [p.target_1, p.target_2, p.target_3].map(fmtNum).filter(Boolean).join(" / "));
    if (status !== "closed" && num(p.remaining_pct) < 100) f(T.remaining, Math.round(num(p.remaining_pct)) + "%");
    if (status === "closed" && rStr) f(T.result, rStr);

    var entryChart = chartBlock(p.tradingview_url, T.entryChart);
    var steps = buildSteps(p);
    var tl = steps.length
      ? '<ol class="mth-tl">' + steps.map(function (s) {
          var link = tgHref(s.mid);
          return '<li class="mth-step"><div class="mth-step-h"><b>' + esc(s.lbl) + "</b><time>" + esc(fmtDateTime(s.ts)) + "</time></div>" +
            s.body + chartBlock(s.chart, T.stepChart) +
            (link ? '<a class="mth-link" href="' + esc(link) + '" target="_blank" rel="noopener">' + esc(T.tgLink) + " ↗</a>" : "") +
            "</li>";
        }).join("") + "</ol>"
      : '<p class="mth-empty">' + esc(T.empty) + "</p>";

    return '<article class="mth-card">' + head + '<div class="mth-fields">' + fields.join("") + "</div>" +
      (entryChart ? '<div class="mth-entry">' + entryChart + "</div>" : "") +
      '<p class="mth-intro">' + esc(T.intro) + "</p>" + tl + "</article>";
  }

  // ------------------------------------------------------------------ modal
  var overlay, box, bodyEl, titleEl, closeBtn, lastFocused = null;
  function buildOverlay() {
    overlay = document.createElement("div");
    overlay.className = "mth-overlay";
    overlay.hidden = true;
    overlay.innerHTML = '<div class="mth-box" role="dialog" aria-modal="true" aria-labelledby="mth-title">' +
      '<div class="mth-bar"><h2 id="mth-title" class="mth-title"></h2>' +
      '<button class="mth-close" type="button" aria-label="' + esc(T.close) + '">✕</button></div>' +
      '<div class="mth-body"></div></div>';
    document.body.appendChild(overlay);
    box = overlay.querySelector(".mth-box");
    bodyEl = overlay.querySelector(".mth-body");
    titleEl = overlay.querySelector(".mth-title");
    closeBtn = overlay.querySelector(".mth-close");
    closeBtn.addEventListener("click", closeModal);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closeModal(); });
    document.addEventListener("keydown", function (e) {
      if (overlay.hidden) return;
      if (e.key === "Escape") { closeModal(); return; }
      if (e.key === "Tab") {
        var fs = Array.prototype.filter.call(box.querySelectorAll("a[href],button"), function (el) { return el.offsetParent !== null; });
        if (!fs.length) return;
        var first = fs[0], last = fs[fs.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
  }
  function openModal(trigger, title, html) {
    if (!overlay) buildOverlay();
    lastFocused = trigger;
    titleEl.textContent = title;
    bodyEl.innerHTML = html;
    overlay.hidden = false;
    document.body.style.overflow = "hidden";
    closeBtn.focus();
  }
  function closeModal() {
    overlay.hidden = true;
    document.body.style.overflow = "";
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }

  // ------------------------------------------------------------------ rows
  // tbody id -> [ticker col, direction col, date col, closed?]
  var TABLES = {
    openBody: [0, 1, 8, false],
    openedWeekBody: [0, 1, 8, false],
    closedWeekBody: [0, 1, 4, true]
  };

  function decorate(tbodyId) {
    var tb = document.getElementById(tbodyId);
    if (!tb || !positions.length) return;
    var cfg = TABLES[tbodyId];
    Array.prototype.forEach.call(tb.rows, function (tr) {
      if (tr.cells.length <= cfg[2] || tr.querySelector(".mth-btn")) return;
      var tickerCell = tr.cells[cfg[0]];
      var ticker = trim(tickerCell.textContent);
      var dir = trim(tr.cells[cfg[1]].textContent);
      var date = trim(tr.cells[cfg[2]].textContent);
      var p = findPosition(ticker, dir, date, cfg[3]);
      if (!p) return;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "mth-btn";
      b.textContent = T.btn;
      b.setAttribute("aria-label", T.btnAria + " " + ticker);
      b.setAttribute("data-position-id", String(p.id));
      tickerCell.appendChild(b);
    });
  }
  function decorateAll() { Object.keys(TABLES).forEach(decorate); }

  document.addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest(".mth-btn") : null;
    if (!b) return;
    e.preventDefault();
    var id = Number(b.getAttribute("data-position-id"));
    var p = positions.filter(function (x) { return x.id === id; })[0];
    if (!p) { openModal(b, T.btnAria, '<p class="mth-empty">' + esc(T.fail) + "</p>"); return; }
    openModal(b, T.title(p.ticker), renderCard(p));
  });

  function start() {
    load().then(function (list) {
      if (!list || !list.length) return;
      decorateAll();
      Object.keys(TABLES).forEach(function (id) {
        var tb = document.getElementById(id);
        if (tb && window.MutationObserver) new MutationObserver(function () { decorate(id); }).observe(tb, { childList: true });
      });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  // Exposed for tests only.
  window.__BFD_MTH__ = { cleanText: cleanText, buildSteps: buildSteps, renderCard: renderCard,
    findPosition: findPosition, _set: function (list) { positions = list; } };
})();

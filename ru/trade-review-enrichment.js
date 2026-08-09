/* Structured, trade-specific enrichment for selected RU review cards.
 *
 * This layer deliberately lives outside the generated manifest. The scheduled
 * manifest refresh can continue to rebuild timelines without replacing the
 * reviewed idea logic, execution notes, or R calculations below.
 */
(function (root) {
  "use strict";

  var ARROW = "↗";
  var IDEA_LABEL = "Публичная идея";
  var PUBLIC_TRADE_IDEA = "Публичная торговая идея";
  var HEADINGS = {
    logic: "ЛОГИКА ИДЕИ",
    risk: "РИСК И ИСПОЛНЕНИЕ",
    calculation: "РАСЧЁТ РЕЗУЛЬТАТА",
    total: "Взвешенный результат"
  };

  // Keys intentionally include asset class and direction. This avoids applying
  // a manual note to an unrelated trade that happens to share ticker and dates.
  var ENRICHMENTS = {
    "eq#l#HIMS|2026-05-12|2026-07-20": {
      tv: "https://www.tradingview.com/chart/HIMS/vO7ESVVg-HIMS-upside-potential/",
      logic: [
        "Локальная зона поддержки 24–22: ожидался более высокий минимум и постепенное продолжение роста."
      ],
      rows: [
        ["Вход", "24,84", "12.05.2026"],
        ["Начальный стоп", "21,53", ""],
        ["Начальный риск на акцию", "3,31", "24,84 − 21,53"],
        ["Риск к цене входа", "13,33%", ""],
        ["Фиксация 50%", "35,26", "18.06.2026"],
        ["Стоп по остатку (поднят)", "30,40", ""],
        ["Итоговый выход", "33", "20.07.2026"]
      ],
      notes: [
        ["Учёт входа", "Позиция отражена с даты публикации сет-апа; идеальным подтверждением входа был пробой максимума предыдущей дневной свечи 19 мая."],
        ["Логика стопа", "Стоп на минимумах зоны поддержки/разворота 18 мая, где цена подтвердила успешный разворот."]
      ],
      calculation: {
        rows: [
          ["50%", "(35,26 − 24,84) / 3,31", "3,15R", "50% закрыто по 35,26 18.06.2026."],
          ["50%", "(33 − 24,84) / 3,31", "2,47R", "Для оставшихся 50% стоп поднят до 30,40; финальный выход 33 20.07.2026."]
        ],
        totalExpression: "0,50 × 3,15R + 0,50 × 2,47R",
        total: "+2,81R",
        formula: "R для лонга = (выход − вход) / начальный риск."
      }
    },
    "eq#s#SNDK|2026-07-13|2026-07-29": {
      tv: "https://www.tradingview.com/chart/SNDK/vpWnVsNI-SNDK-Short-term-Trend-Structure/",
      logic: [
        "Опубликована на премаркете 13.07.2026. Ориентир входа: цена закрытия сессии 10.07.2026.",
        "Пока цена ниже сопротивления 2130, ожидалась коррекционная волна к 1230 и 1030."
      ],
      rows: [
        ["Ориентир входа", "1915,92", "цена закрытия 10.07.2026"],
        ["Инвалидация (начальный стоп)", "2130", ""],
        ["Начальный риск на акцию", "214,08", "2130 − 1915,92"],
        ["Риск к цене входа", "11,17%", ""],
        ["TP1 — 50%", "1230", "27.07.2026"],
        ["TP2 — 50%", "1030", "29.07.2026"],
        ["Позиция закрыта полностью", "29.07.2026", ""]
      ],
      notes: [
        ["Движение цены", "Максимум закрытия 1757,82 14.07, стоп не тестировался; поддержка 1390/1325 достигнута 16–17.07; отскок к 1610,33 23.07."],
        ["Исполнение целей", "50% TP1 по 1230 27.07, минимум дня 1222,01; 50% TP2 по 1030 29.07, минимум дня 998,19."]
      ],
      calculation: {
        rows: [
          ["50%", "(1915,92 − 1230) / 214,08", "3,20R", "TP1: 50% по 1230 27.07.2026, минимум дня 1222,01."],
          ["50%", "(1915,92 − 1030) / 214,08", "4,14R", "TP2: 50% по 1030 29.07.2026, минимум дня 998,19."]
        ],
        totalExpression: "0,50 × 3,20R + 0,50 × 4,14R",
        total: "+3,67R",
        formula: "R для шорта = (вход − выход) / начальный риск."
      }
    }
  };

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function toISO(value) {
    var text = String(value || "").trim();
    var m = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) return m[3] + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0");
    m = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[1] + "-" + m[2] + "-" + m[3] : "";
  }

  function keyFor(data) {
    var assetClass = String(data && data.assetClass || "").toLowerCase();
    var ac = assetClass === "eq" || assetClass === "equities" || assetClass === "stock" ? "eq" :
      (assetClass === "cr" || assetClass === "crypto" ? "cr" : "");
    var direction = String(data && data.dir || "").trim().toLowerCase().charAt(0);
    var ticker = String(data && data.ticker || "").toUpperCase();
    var entry = toISO(data && data.entryDate);
    var exit = toISO(data && data.exitDate);
    return ac && direction && ticker && entry && exit
      ? ac + "#" + direction + "#" + ticker + "|" + entry + "|" + exit
      : "";
  }

  function sectionHeading(text) {
    return '<div class="tl-h"><b>' + esc(text) + "</b><i></i></div>";
  }

  function render(enrichment) {
    if (!enrichment) return "";
    var html = '<section class="tl" aria-label="' + esc(PUBLIC_TRADE_IDEA) + '">';

    html += '<div class="tl-sec">' + sectionHeading(HEADINGS.logic) +
      '<p class="tl-public-label">' + esc(PUBLIC_TRADE_IDEA) + "</p>";
    enrichment.logic.forEach(function (paragraph) {
      html += '<p class="tl-p">' + esc(paragraph) + "</p>";
    });
    html += '<p class="tl-p">' + esc(IDEA_LABEL) + ': <a class="brc-inline-link" href="' +
      esc(enrichment.tv) + '" target="_blank" rel="noopener">' + esc(IDEA_LABEL) + " " + ARROW + "</a></p></div>";

    html += '<div class="tl-sec">' + sectionHeading(HEADINGS.risk) + '<dl class="tl-rows">';
    enrichment.rows.forEach(function (row) {
      html += '<div class="tl-row"><dt>' + esc(row[0]) + "</dt><dd>" + esc(row[1]) +
        (row[2] ? " <em>" + esc(row[2]) + "</em>" : "") + "</dd></div>";
    });
    html += "</dl>";
    enrichment.notes.forEach(function (note) {
      html += '<p class="tl-note"><span>' + esc(note[0]) + ":</span> " + esc(note[1]) + "</p>";
    });
    html += "</div>";

    html += '<div class="tl-sec">' + sectionHeading(HEADINGS.calculation) + '<div class="tl-calc">';
    enrichment.calculation.rows.forEach(function (row) {
      html += '<div class="tl-calc-row"><span class="tl-calc-leg">' + esc(row[0]) +
        '</span><span class="tl-calc-expr">' + esc(row[1]) +
        '</span><span class="tl-calc-r">' + esc(row[2]) +
        '</span><span class="tl-calc-sub">' + esc(row[3]) + "</span></div>";
    });
    html += '</div><div class="tl-calc-total"><span class="tl-total-k">' + esc(HEADINGS.total) +
      '</span><span class="tl-total-v">' + esc(enrichment.calculation.total) +
      '</span><span class="tl-total-expr">' + esc(enrichment.calculation.totalExpression) + " = " +
      esc(enrichment.calculation.total) + '</span></div><p class="tl-formula">' +
      esc(enrichment.calculation.formula) + "</p></div></section>";
    return html;
  }

  function inject(cardHTML, data) {
    var key = keyFor(data);
    var enrichment = ENRICHMENTS[key];
    if (!enrichment || /class="tl"/.test(cardHTML)) return cardHTML;
    var block = render(enrichment);
    if (cardHTML.indexOf('<p class="bot-intro">') !== -1) {
      return cardHTML.replace('<p class="bot-intro">', block + '<p class="bot-intro">');
    }
    if (cardHTML.indexOf('<div class="rc-method">') !== -1) {
      return cardHTML.replace('<div class="rc-method">', block + '<div class="rc-method">');
    }
    if (cardHTML.indexOf('<div class="promo">') !== -1) {
      return cardHTML.replace('<div class="promo">', block + '<div class="promo">');
    }
    return cardHTML;
  }

  var api = {
    data: ENRICHMENTS,
    keyFor: keyFor,
    render: render,
    inject: inject
  };
  root.BelfedReviewEnrichment = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

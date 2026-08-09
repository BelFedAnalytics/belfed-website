"use strict";

const assert = require("assert");
const path = require("path");

const enrichment = require(path.join(__dirname, "..", "ru", "trade-review-enrichment.js"));

const HIMS_KEY = "eq#l#HIMS|2026-05-12|2026-07-20";
const SNDK_KEY = "eq#s#SNDK|2026-07-13|2026-07-29";
const HIMS_TV = "https://www.tradingview.com/chart/HIMS/vO7ESVVg-HIMS-upside-potential/";
const SNDK_TV = "https://www.tradingview.com/chart/SNDK/vpWnVsNI-SNDK-Short-term-Trend-Structure/";

function dataFor(ticker, dir, entryDate, exitDate) {
  return { ticker, dir, entryDate, exitDate, assetClass: "eq" };
}

function assertContains(text, snippets) {
  snippets.forEach((snippet) => assert.ok(text.includes(snippet), `missing ${snippet}`));
}

assert.strictEqual(
  enrichment.keyFor(dataFor("HIMS", "Long", "12.05.2026", "20.07.2026")),
  HIMS_KEY,
);
assert.strictEqual(
  enrichment.keyFor(dataFor("SNDK", "Short", "13.07.2026", "29.07.2026")),
  SNDK_KEY,
);
assert.strictEqual(
  enrichment.keyFor({ ticker: "HIMS", dir: "Long", entryDate: "12.05.2026", exitDate: "20.07.2026" }),
  "",
  "manual enrichment must require a collision-safe asset-class key",
);

const hims = enrichment.render(enrichment.data[HIMS_KEY]);
assertContains(hims, [
  "Публичная торговая идея",
  "Вход",
  "24,84",
  "Начальный стоп",
  "21,53",
  "13,33%",
  "(35,26 − 24,84) / 3,31",
  "3,15R",
  "(33 − 24,84) / 3,31",
  "2,47R",
  "0,50 × 3,15R + 0,50 × 2,47R = +2,81R",
  HIMS_TV,
]);

const sndk = enrichment.render(enrichment.data[SNDK_KEY]);
assertContains(sndk, [
  "Публичная торговая идея",
  "Ориентир входа: цена закрытия сессии 10.07.2026.",
  "1915,92",
  "2130",
  "214,08",
  "11,17%",
  "(1915,92 − 1230) / 214,08",
  "3,20R",
  "(1915,92 − 1030) / 214,08",
  "4,14R",
  "0,50 × 3,20R + 0,50 × 4,14R = +3,67R",
  SNDK_TV,
]);

const forbidden = [
  /отдельного\s+сигнала\s+на\s+вход/i,
  /без\s+сигнала/i,
  /исключен[а-яё]*\s+из\s+статистики\s+сигналов/i,
  /последняя\s+доступная\s+на\s+момент\s+публикации\s+цена\s+закрытия/i,
];
[hims, sndk].forEach((html) => {
  forbidden.forEach((pattern) => assert.ok(!pattern.test(html), `forbidden copy: ${pattern}`));
  assert.ok(!html.includes("<img"), "enrichment must not change or add chart assets");
});

const himsCard = '<article><div class="card-meta">meta</div><p class="bot-intro">intro</p><ol class="timeline"></ol></article>';
const himsInjected = enrichment.inject(
  himsCard,
  dataFor("HIMS", "Long", "12.05.2026", "20.07.2026"),
);
assert.ok(himsInjected.indexOf('class="tl"') > himsInjected.indexOf('class="card-meta"'));
assert.ok(himsInjected.indexOf('class="tl"') < himsInjected.indexOf('class="bot-intro"'));
assert.strictEqual(
  enrichment.inject(himsInjected, dataFor("HIMS", "Long", "12.05.2026", "20.07.2026")),
  himsInjected,
  "renderer must be idempotent",
);

const sndkCard = '<article><div class="fields"></div><div class="rc-method">method</div><div class="promo">promo</div></article>';
const sndkInjected = enrichment.inject(
  sndkCard,
  dataFor("SNDK", "Short", "13.07.2026", "29.07.2026"),
);
assert.ok(sndkInjected.indexOf('class="tl"') > sndkInjected.indexOf('class="fields"'));
assert.ok(sndkInjected.indexOf('class="tl"') < sndkInjected.indexOf('class="rc-method"'));
assert.strictEqual(
  enrichment.inject(sndkCard, dataFor("SNDK", "Long", "13.07.2026", "29.07.2026")),
  sndkCard,
  "direction collision must not borrow the SNDK short enrichment",
);

console.log("trade review enrichment tests passed");

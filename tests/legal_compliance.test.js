#!/usr/bin/env node
/*
 * Legal/compliance remediation batch 1 — regression tests.
 *
 * Guards the reversible fixes from the 2026-07-23 audit:
 *   - consent controls are unchecked by default (no pre-checked opt-in);
 *   - required consent gates submission; marketing consent is optional;
 *   - legal links resolve to the RU documents;
 *   - prohibited wording (categorical no-refund, allocation-advice /
 *     personalised-suitability phrasing) is absent;
 *   - RU privacy policy reflects the real stack + differentiated deadlines.
 *
 * No dependencies. Run: node tests/legal_compliance.test.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let failures = 0;
function ok(cond, msg) {
  if (cond) { console.log("  ok - " + msg); }
  else { console.error("  FAIL - " + msg); failures++; }
}
function section(name) { console.log("\n# " + name); }

// Match a checkbox <input> by id and report whether it carries a `checked` attr.
function checkboxChecked(html, id) {
  const re = new RegExp("<input[^>]*id=[\"']" + id + "[\"'][^>]*>", "i");
  const m = html.match(re);
  if (!m) return { found: false, checked: false };
  return { found: true, checked: /\bchecked\b/i.test(m[0]) };
}

// ---------------------------------------------------------------- index.html
section("index.html — landing lead/asset-request form");
const index = read("index.html");

const dataCb = checkboxChecked(index, "consentData");
ok(dataCb.found, "required data-processing consent checkbox #consentData exists");
ok(dataCb.found && !dataCb.checked, "#consentData is NOT pre-checked");

const mktCb = checkboxChecked(index, "consentMarketing");
ok(mktCb.found, "optional marketing consent checkbox #consentMarketing exists");
ok(mktCb.found && !mktCb.checked, "#consentMarketing is NOT pre-checked");

ok(!/id=["']consent["'][^>]*checked/i.test(index),
   "no legacy pre-checked #consent checkbox remains");

ok(/if\s*\(\s*!\s*dataConsent\s*\)/.test(index),
   "submit handler gates on required data consent");
ok(/consentDataErr/.test(index) && /role=["']alert["']/.test(index),
   "accessible inline error element for required consent exists");
ok(/marketing_consent\s*:/.test(index) && /data_consent\s*:/.test(index),
   "payload sends separated marketing_consent and data_consent flags");
ok(/consent\s*:\s*marketingConsent/.test(index),
   "legacy `consent` field kept as backward-compatible marketing alias");

section("index.html — high-risk wording removed");
ok(!/Где должен находиться капитал/.test(index),
   "prescriptive 'где должен находиться капитал' removed");
ok(!/аллокации активов/.test(index) && !/распределению активов/.test(index),
   "asset-allocation-advice phrasing removed");
ok(/не являются индивидуальной инвестиционной рекомендацией/.test(index),
   "homepage states materials are not individual investment recommendations");

section("index.html — legal links point to RU docs");
ok(/href=["']\/ru\/disclaimer\.html["']/.test(index),
   "footer disclaimer link points to /ru/disclaimer.html");
ok(/href=["']\/ru\/privacy\.html["']/.test(index),
   "privacy link present");
ok(/href=["']\/ru\/oferta\.html["']/.test(index),
   "oferta link present");

// -------------------------------------------------------------- ru/trial.html
section("ru/trial.html — signup consent");
const trial = read("ru/trial.html");
const pv = checkboxChecked(trial, "acceptPrivacy");
const tm = checkboxChecked(trial, "acceptTerms");
ok(pv.found && !pv.checked, "#acceptPrivacy is NOT pre-checked");
ok(tm.found && !tm.checked, "#acceptTerms is NOT pre-checked");
ok(/if\s*\(\s*!hasPrivacy\s*\)/.test(trial) && /if\s*\(\s*!hasTerms\s*\)/.test(trial),
   "submit gates on both required consents");
ok(/aria-invalid/.test(trial), "invalid consents flagged with aria-invalid");
ok(/href=["']\/ru\/privacy\.html["']/.test(trial) &&
   /href=["']\/ru\/oferta\.html["']/.test(trial) &&
   /href=["']\/ru\/disclaimer\.html["']/.test(trial),
   "trial form links to RU privacy, oferta, disclaimer");
ok(/Без рекламной рассылки/.test(trial),
   "signup email is service-only (no marketing bundled)");

// ------------------------------------------------------------ ru/privacy.html
section("ru/privacy.html — stack + deadlines + version");
const privacy = read("ru/privacy.html");
ok(/Версия 2\.0/.test(privacy) && /23 июля 2026/.test(privacy),
   "privacy policy has updated version + date");
ok(/Tribute/.test(privacy), "Tribute documented as primary payment channel");
ok(/EU-West/.test(privacy) && /Supabase/.test(privacy),
   "Supabase EU-West documented");
ok(/Brevo/.test(privacy) && /Cloudflare/.test(privacy) && /Telegram/.test(privacy),
   "Brevo, Cloudflare/GitHub, Telegram documented");
ok(/7 рабочих дней/.test(privacy) && /10 рабочих дней/.test(privacy) &&
   /3 рабочих дней/.test(privacy),
   "differentiated subject-rights deadlines present (3/7/10 working days)");
ok(/ч\.\s*5 ст\.\s*18/.test(privacy) && /ст\.\s*12/.test(privacy),
   "localization (ч.5 ст.18) and cross-border (ст.12) described");
ok(!/не является подтверждением факта подачи/.test(privacy) === false,
   "does not assert unverified regulatory filings");

// ------------------------------------------------------------- ru/oferta.html
section("ru/oferta.html — refund + asset requests");
const oferta = read("ru/oferta.html");
ok(!/возврат оплаты за текущий расчётный период не производится/.test(oferta),
   "categorical no-refund-after-access rule removed");
ok(/отказаться от исполнения договора в любое время/.test(oferta),
   "right to cancel at any time (ст.32) stated");
ok(/фактически понесённых/.test(oferta),
   "refund less documented actual expenses stated");
ok(/предложением темы/.test(oferta),
   "asset requests defined as topic suggestions, not individual recommendations");
ok(/Версия 3/.test(oferta), "oferta version bumped");

// --------------------------------------------------------- ru/disclaimer.html
section("ru/disclaimer.html — refund aligned");
const disc = read("ru/disclaimer.html");
ok(!/возврат оплаты за текущий расчётный период не производится/.test(disc),
   "disclaimer no longer states categorical no-refund");
ok(/отказаться от услуги в любое время/.test(disc),
   "disclaimer states right to cancel at any time");

// -------------------------------------------------------------------- summary
console.log("\n" + (failures ? "FAILED: " + failures + " check(s)" : "All checks passed"));
process.exit(failures ? 1 : 0);

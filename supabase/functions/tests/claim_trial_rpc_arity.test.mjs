// Regression guard for the 2026-07-17 production incident:
// bot-claim-trial v21 returned HTTP 500 because public.claim_trial_by_telegram
// exists as BOTH a legacy 5-arg overload and the 11-arg overload from migration
// 017 (CREATE OR REPLACE with 6 new defaulted args creates a *second* overload,
// it does not replace the old one). A 5-named-param RPC call is satisfiable by
// both overloads, so PostgREST fails resolution with PGRST203 (ambiguous).
//
// The fix: every edge caller must pass ALL 11 named params so only the 11-arg
// overload matches. This test parses the edge function sources and asserts the
// full param set is present in each claim_trial_by_telegram RPC call.
//
// Run: node --test supabase/functions/tests/

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const functionsDir = join(here, "..");

// The canonical 11 named parameters of the 11-arg overload
// (supabase/migrations/20260603_017_claim_trial_link_by_email.sql).
const REQUIRED_PARAMS = [
  "p_telegram_id",
  "p_telegram_username",
  "p_trial_days",
  "p_source",
  "p_lang",
  "p_email",
  "p_privacy_consent_at",
  "p_terms_consent_at",
  "p_consent_ip",
  "p_consent_ua",
  "p_consent_locale",
];

// Extract the object literal passed to the first
// admin.rpc("claim_trial_by_telegram", { ... }) call in a source file, by
// brace-matching from the opening "{" after the RPC name.
function extractRpcArgObject(src) {
  const anchor = src.indexOf('rpc("claim_trial_by_telegram"');
  assert.notEqual(anchor, -1, "no claim_trial_by_telegram RPC call found");
  const braceStart = src.indexOf("{", anchor);
  assert.notEqual(braceStart, -1, "no arg object found after RPC call");
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(braceStart, i + 1);
    }
  }
  throw new Error("unbalanced braces in RPC arg object");
}

function paramKeys(objLiteral) {
  return REQUIRED_PARAMS.filter((p) =>
    new RegExp(`(^|[^\\w])${p}\\s*:`).test(objLiteral)
  );
}

for (const fn of ["bot-claim-trial", "tribute-webhook"]) {
  test(`${fn} passes all 11 named claim_trial_by_telegram params (PGRST203 guard)`, () => {
    const src = readFileSync(join(functionsDir, fn, "index.ts"), "utf8");
    const argObj = extractRpcArgObject(src);
    const present = paramKeys(argObj);
    const missing = REQUIRED_PARAMS.filter((p) => !present.includes(p));
    assert.deepEqual(
      missing,
      [],
      `${fn} omits ${missing.length} param(s): ${missing.join(", ")}. ` +
        `Passing fewer than 11 named params leaves the call ambiguous between ` +
        `the legacy 5-arg overload and the 11-arg overload (PGRST203).`
    );
  });
}

test("bot-claim-trial preserves custom x-bot-secret auth", () => {
  const src = readFileSync(join(functionsDir, "bot-claim-trial", "index.ts"), "utf8");
  assert.match(src, /x-bot-secret/, "x-bot-secret header handling must remain");
  assert.match(src, /BOT_SHARED_SECRET/, "shared-secret comparison must remain");
});

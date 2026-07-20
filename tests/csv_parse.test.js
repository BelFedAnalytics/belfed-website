#!/usr/bin/env node
/*
 * Regression: the RU results pages must parse the gviz CSV per RFC 4180 so that
 * a quoted note cell (col N / idx 13) containing an embedded newline does NOT
 * shift later columns. The old parser split the whole export on \n first, which
 * tore such a record in two; the head fragment kept only cols 0-13 (14 fields),
 * so the Members-Signal cell (idx 14 crypto / idx 19 equities) went undefined
 * and the member dot silently vanished.
 *
 * This test extracts the REAL parseCSV from each HTML page (brace-matched + vm)
 * and asserts the member column survives an embedded-newline note. Run:
 *   node tests/csv_parse.test.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const RU = path.join(__dirname, "..", "ru");
let failures = 0;
function ok(cond, msg) {
  if (cond) { console.log("  ok - " + msg); }
  else { console.error("  FAIL - " + msg); failures++; }
}

function extractParseCSV(html) {
  const marker = "function parseCSV(text){";
  const start = html.indexOf(marker);
  if (start < 0) throw new Error("parseCSV not found");
  let depth = 0, end = -1;
  for (let i = html.indexOf("{", start); i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end) + "\nthis.parseCSV=parseCSV;", ctx);
  return ctx.parseCSV;
}

// One data row whose note (col idx 13) holds an embedded newline AND a comma,
// followed by populated Members-Signal + tail columns.
function csvWithMultilineNote(memberIdx) {
  const cols = [];
  for (let i = 0; i <= memberIdx + 1; i++) cols.push("c" + i);
  cols[1] = "TSLA";                 // ticker
  cols[3] = "Closed";               // status
  cols[13] = '"line one,\nline two"'; // quoted note: embedded comma + newline
  cols[memberIdx] = "yes";          // Members-Signal
  const header = "Number,Ticker\r\n";      // 1 header line (skipped by i<1)
  return header + cols.join(",") + "\r\n";
}

for (const [file, memberIdx, label] of [
  ["trades.html", 14, "crypto (idx 14)"],
  ["equities.html", 19, "equities (idx 19)"],
]) {
  console.log("# " + file + " — " + label);
  const parseCSV = extractParseCSV(fs.readFileSync(path.join(RU, file), "utf8"));
  const rows = parseCSV(csvWithMultilineNote(memberIdx));
  const data = rows.filter((r, i) => i >= 1 && r[1] && r[1].trim().toLowerCase() !== "ticker");
  ok(data.length === 1, "quoted-newline record stays ONE row (got " + data.length + ")");
  const r = data[0];
  ok(r[1] === "TSLA", "ticker aligned at idx 1");
  ok(r[3] === "Closed", "status aligned at idx 3");
  ok(String(r[memberIdx]).trim().toLowerCase() === "yes",
     "Members-Signal survives at idx " + memberIdx + " (got " + JSON.stringify(r[memberIdx]) + ")");
  ok(r[13].indexOf("line two") !== -1, "note field keeps both lines");

  // Plain single-line rows still parse.
  const plain = parseCSV("Number,Ticker\r\nA,GOOG,Long,Closed\r\n");
  ok(plain.length === 2 && plain[1][1] === "GOOG", "plain rows still parse");
}

if (failures) { console.error("\n" + failures + " assertion(s) failed"); process.exit(1); }
console.log("\nAll CSV-parser assertions passed.");

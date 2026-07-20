#!/usr/bin/env python3
"""Repeatable RU trade audit + card-manifest builder.

Reconciles the public /ru results pages (dot + Review cards) against the
authoritative Google Sheet exports and the live Supabase snapshot.

Inputs (default dir: trade_audit_2026-07-20/ next to the repo):
  equities_rows.json  full Equties sheet (A1:AB1100), header row index 2,
                      Members Signal = column T / index 19
  crypto_rows.json    full Crypto sheet, header row index 2,
                      Members Signal = column O / index 14
  supabase_audit.json {positions:[...], recaps:[...]} with nested
                      position_events and partial_closes

Outputs:
  ru_reconciliation.csv   one row per audited sheet row
  ru_audit_report stats   printed to stdout
  (with --build) rewrites ru/trade_review_cards.json in place, adding /
  upgrading bot-card timelines for every position with a genuine Supabase
  history, keyed collision-safely.

Matching key (mirrors ru/trade-review.js keyFor):
  full = TICKER|ENTRY_ISO|EXIT_ISO   pair = TICKER|ENTRY_ISO
The builder additionally emits asset-class + direction qualified keys so
duplicate ticker/date trades across crypto and equities never collide.

Yes is treated case-insensitively and whitespace-trimmed.
"""
import json
import os
import re
import sys
import argparse

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
DEFAULT_AUDIT = os.path.join(os.path.dirname(REPO), "trade_audit_2026-07-20")
MANIFEST = os.path.join(REPO, "ru", "trade_review_cards.json")

RU_CHANNEL = "3773738299"   # -1003773738299 without the -100 prefix
RU_TOPIC = "4"              # trades topic in the RU paid community
TRIAL_HREF = "https://belfed.ru/ru/trial.html?source=trial_tradehistory_modal_ru"

MEMBER_COL = {"equities": 19, "crypto": 14}
HEADER_ROW = 2

STEP_LABEL = {
    "opened": "Открытие",
    "opened_addon": "Добавление",
    "stop_hit": "Стоп сработал",
    "stop_moved": "Стоп перенесён",
    "closed": "Закрытие",
    "target_1_hit": "Цель 1 достигнута",
    "target_2_hit": "Цель 2 достигнута",
    "target_3_hit": "Цель 3 достигнута",
    "partial_closed": "Частичное закрытие",
    "edited": "Обновление",
}
BOT_INTRO = ("Ниже представлены сообщения, опубликованные в подписной группе "
             "в течение жизненного цикла этой сделки.")


def load(audit_dir):
    with open(os.path.join(audit_dir, "equities_rows.json")) as f:
        eq = json.load(f)
    with open(os.path.join(audit_dir, "crypto_rows.json")) as f:
        cr = json.load(f)
    with open(os.path.join(audit_dir, "supabase_audit.json")) as f:
        sb = json.load(f)
    with open(MANIFEST) as f:
        man = json.load(f)
    return eq, cr, sb, man


def cell(row, i):
    return row[i].strip() if i < len(row) and row[i] is not None else ""


def is_yes(v):
    return str(v or "").strip().lower() == "yes"


def to_iso(d):
    d = (d or "").strip()
    if not d:
        return ""
    m = re.match(r"^(\d{1,2})\.(\d{1,2})\.(\d{4})$", d)
    if m:
        return "%s-%s-%s" % (m.group(3), m.group(2).zfill(2), m.group(1).zfill(2))
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", d)
    return "%s-%s-%s" % (m.group(1), m.group(2), m.group(3)) if m else ""


def iso_from_ts(ts):
    """ISO date from a Supabase timestamp (or date)."""
    if not ts:
        return ""
    return str(ts)[:10]


def key_full(ticker, entry, exit_):
    return "%s|%s|%s" % (ticker.upper(), to_iso(entry), to_iso(exit_))


def key_pair(ticker, entry):
    return "%s|%s" % (ticker.upper(), to_iso(entry))


def key_safe(asset_class, ticker, direction, entry, exit_):
    """Collision-safe key: asset class + direction qualified.

    Must stay byte-identical to ru_card_build.build's inner key_safe (which
    writes these keys into the manifest) and to trade-review.js keyFor().safe
    (which reads them), so a card written under this key is found in-browser:
        ac#d#TICKER|entryISO|exitISO
    """
    ac = "eq" if asset_class in ("equities", "stock") else "cr"
    dr = (direction or "").strip().lower()[:1] or "?"
    return "%s#%s#%s|%s|%s" % (ac, dr, ticker.upper(), to_iso(entry), to_iso(exit_))


def sheet_data_rows(rows, asset_class):
    """Yield (row_number_1based, row) for real data rows."""
    out = []
    for idx in range(HEADER_ROW + 1, len(rows)):
        r = rows[idx]
        t = cell(r, 1)
        if not t or t.lower() == "ticker":
            continue
        out.append((idx + 1, r))  # 1-based spreadsheet row number
    return out


def position_index(sb):
    """Index positions by (asset, ticker, entry_iso) and by sheet_row_id."""
    by_field = {}
    by_rowid = {}
    for p in sb["positions"]:
        by_rowid[p["sheet_row_id"]] = p
        ac = "crypto" if p.get("asset_class") == "crypto" else "equities"
        ent = iso_from_ts(p.get("opened_at"))
        by_field.setdefault((ac, p["ticker"].upper(), ent), []).append(p)
    return by_field, by_rowid


def position_is_rich(p):
    """A genuine Supabase timeline exists -- either published or evidence-based.

    Mirrors ru_card_build.is_eligible exactly so the audit's expectation matches
    what the builder writes. A card is warranted when there is:
      * >=1 published event (carries message_id_ru), or
      * >=1 partial close, or
      * a close_comment_ru, or
      * an event payload comment (payload.comment_ru).
    A lone position.comment_ru with none of the above is a bare idea note, not a
    lifecycle, and stays a legacy card (no fabrication).
    """
    evs = p.get("events") or []
    if any(e.get("message_id_ru") for e in evs):
        return True
    if p.get("partial_closes"):
        return True
    if p.get("close_comment_ru"):
        return True
    if any((e.get("payload") or {}).get("comment_ru") for e in evs):
        return True
    return False


# ---------------------------------------------------------------- audit ----
def audit(eq, cr, sb, man):
    by_field, by_rowid = position_index(sb)
    records = []
    for asset_class, rows in (("equities", eq), ("crypto", cr)):
        mcol = MEMBER_COL[asset_class]
        for rownum, r in sheet_data_rows(rows, asset_class):
            ticker = cell(r, 1)
            direction = cell(r, 2)
            status = cell(r, 3)
            entry = cell(r, 4)
            exit_ = cell(r, 5)
            member_raw = cell(r, mcol)
            member_yes = is_yes(member_raw)
            expected_dot = member_yes
            # Pre-fix state: neither /ru results page reads the Members Signal
            # column, so no dot is ever rendered. Recorded so the report shows
            # the gap the fix closes; post-fix the dot is data-driven (== expected).
            current_dot = False
            kf, kp = key_full(ticker, entry, exit_), key_pair(ticker, entry)
            entry_m = man.get(kf) or man.get(kp)
            manifest_match = "full" if kf in man else ("pair" if kp in man else "none")
            card_kind = entry_m["kind"] if entry_m else "fallback"
            step_count = entry_m["ru"].count('class="step"') if entry_m else 0
            actual_dot = current_dot

            # Supabase match: prefer field match (asset+ticker+entry), fall back to row id
            pos = None
            cands = by_field.get((asset_class, ticker.upper(), to_iso(entry)), [])
            if len(cands) == 1:
                pos = cands[0]
            elif len(cands) > 1:
                # disambiguate by exit date
                for c in cands:
                    if iso_from_ts(c.get("closed_at")) == to_iso(exit_):
                        pos = c
                        break
                pos = pos or cands[0]
            rowid = "%s:%d" % ("Equties" if asset_class == "equities" else "Crypto", rownum)
            if pos is None:
                pos = by_rowid.get(rowid)

            ev = len(pos.get("events", [])) if pos else 0
            pc = len(pos.get("partial_closes", [])) if pos else 0
            rich = position_is_rich(pos) if pos else False
            sb_match = pos["sheet_row_id"] if pos else "none"

            records.append({
                "asset_class": asset_class,
                "sheet_row": rownum,
                "ticker": ticker,
                "direction": direction,
                "status": status,
                "entry": entry,
                "exit": exit_,
                "member_raw": member_raw,
                "member_yes": member_yes,
                "expected_dot": expected_dot,
                "actual_dot": actual_dot,
                "manifest_match": manifest_match,
                "card_kind": card_kind,
                "step_count": step_count,
                "sb_match": sb_match,
                "sb_events": ev,
                "sb_partials": pc,
                "sb_rich": rich,
                "closed": status.lower() == "closed",
            })
    return records


def resolve(rec):
    """Classify each record's resolution / issue."""
    issues = []
    # dot issues
    if rec["member_yes"] and not rec["actual_dot"]:
        issues.append("DOT_MISSING")
    # card/history issues -- only closed rows are rendered and thus expected to
    # carry a bot card; open/merged positions are intentionally not prebuilt.
    if rec["closed"] and rec["sb_rich"] and rec["card_kind"] != "bot":
        issues.append("HISTORY_MISSING_BUT_AVAILABLE")
    if rec["card_kind"] == "bot" and rec["step_count"] == 0:
        issues.append("BOT_CARD_EMPTY")
    if not rec["sb_rich"] and rec["card_kind"] == "fallback" and rec["closed"]:
        issues.append("LEGACY_FALLBACK_NO_EVIDENCE")
    return issues


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audit-dir", default=DEFAULT_AUDIT)
    ap.add_argument("--csv", default=None)
    ap.add_argument("--build", action="store_true",
                    help="rewrite ru/trade_review_cards.json with corrected bot cards")
    ap.add_argument("--json-out", default=None, help="dump raw records as JSON")
    args = ap.parse_args()

    eq, cr, sb, man = load(args.audit_dir)
    records = audit(eq, cr, sb, man)

    for rec in records:
        rec["issues"] = resolve(rec)

    # summary
    n = len(records)
    closed = sum(1 for r in records if r["closed"])
    yes = sum(1 for r in records if r["member_yes"])
    dot_missing = sum(1 for r in records if "DOT_MISSING" in r["issues"])
    hist_missing = sum(1 for r in records if "HISTORY_MISSING_BUT_AVAILABLE" in r["issues"])
    bot_cards = sum(1 for r in records if r["card_kind"] == "bot")
    print("rows=%d closed=%d member_yes=%d dot_missing=%d bot_cards=%d history_missing=%d"
          % (n, closed, yes, dot_missing, bot_cards, hist_missing))

    csv_path = args.csv
    if csv_path:
        write_csv(records, csv_path)
        print("wrote", csv_path)
    if args.json_out:
        with open(args.json_out, "w") as f:
            json.dump(records, f, ensure_ascii=False, indent=1)
        print("wrote", args.json_out)
    if args.build:
        import ru_card_build
        changed = ru_card_build.build(eq, cr, sb, man)
        with open(MANIFEST, "w") as f:
            json.dump(man, f, ensure_ascii=False, separators=(",", ":"))
        print("manifest updated: %d bot cards written/upgraded" % changed)


def write_csv(records, path):
    import csv
    cols = ["asset_class", "sheet_row", "ticker", "direction", "status",
            "entry", "exit", "member_raw", "member_yes", "expected_dot",
            "actual_dot", "manifest_match", "card_kind", "step_count",
            "sb_match", "sb_events", "sb_partials", "sb_rich", "issues"]
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for r in records:
            w.writerow([r.get(c) if c != "issues" else "|".join(r["issues"]) for c in cols])


if __name__ == "__main__":
    main()

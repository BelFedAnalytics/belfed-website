#!/usr/bin/env python3
"""Post-close refresh for the RU review-card manifest.

Newly closed trades appear on the results pages the moment the Google Sheet is
updated, but their Review card stays on the generic no-timeline fallback until
`ru/trade_review_cards.json` is rebuilt. This script performs that rebuild
unattended so the gap closes on its own.

Two inputs, neither of which is ever written to the repo:

  * the same public Google Sheet CSV the pages already fetch (no credentials);
  * a sanitized read of the Supabase lifecycle tables (credentials required).

Only whitelisted, RU-facing fields are kept from Supabase. English payloads,
Telegram EN message ids and every column not consumed by the card builder are
dropped at the boundary, so a raw production dump can never reach the manifest
or the runner log.

Row identity does NOT rely on CSV row alignment. The gviz export drops leading
header rows, so absolute spreadsheet row numbers are not recoverable from it.
Instead each Supabase position is matched to its sheet row by ticker + entry
date, and the matched row is placed at the index its own `sheet_row_id` names.
The builder's closed-only gate then runs against genuine sheet data. A position
with no unambiguous live match is skipped rather than guessed at.

Exit status: 0 on success (whether or not anything changed), 1 on error.
Writes `changed=true|false` to $GITHUB_OUTPUT when running under Actions.
"""
import argparse
import csv
import io
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import ru_card_build  # noqa: E402

MANIFEST = os.path.join(REPO, "ru", "trade_review_cards.json")

SHEET_ID = "1bBpKZP74HEVrLZJlazz7gY7jbuBj9R5rPBcV2KklwDo"
GIDS = {"crypto": "1219794768", "equities": "0"}
# Sheet tab name embedded in Supabase's sheet_row_id (the equities typo is the
# production spelling and must be matched exactly).
TAB = {"crypto": "Crypto", "equities": "Equties"}

TIMEOUT = 30

# Supabase objects. Overridable because the lifecycle tables live in the
# trading bot's schema, which this repository does not own.
POSITIONS_TABLE = os.environ.get("SUPABASE_POSITIONS_TABLE", "active_positions")
EVENTS_REL = os.environ.get("SUPABASE_EVENTS_RELATION", "position_events")
PARTIALS_REL = os.environ.get("SUPABASE_PARTIALS_RELATION", "partial_closes")

# Whitelists: the only fields allowed to cross the boundary from Supabase.
POSITION_FIELDS = ("id", "ticker", "direction", "asset_class", "status",
                   "opened_at", "closed_at", "exit_price", "result_rr",
                   "comment_ru", "close_comment_ru", "sheet_row_id")
EVENT_FIELDS = ("event_type", "message_id_ru", "triggered_at")
PAYLOAD_FIELDS = ("triggered_price", "old_stop", "new_stop", "is_addon",
                  "partial_close_id", "comment_ru")
PARTIAL_FIELDS = ("id", "pct_closed", "exit_price", "closed_at", "comment_ru")


def log(msg):
    print(msg, flush=True)


# ------------------------------------------------------------------ sheet ---
def fetch_csv(gid, opener=None):
    url = ("https://docs.google.com/spreadsheets/d/%s/gviz/tq"
           "?tqx=out:csv&gid=%s&single=true" % (SHEET_ID, urllib.parse.quote(gid)))
    get = opener or _http_get
    return get(url, headers={})


def _http_get(url, headers):
    if not url.startswith("https://"):
        raise ValueError("refusing non-HTTPS request")
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read().decode("utf-8")


def parse_rows(text):
    """CSV text -> list of trimmed string rows (quoted newlines preserved)."""
    return [[(c or "").strip() for c in row]
            for row in csv.reader(io.StringIO(text))]


def index_sheet(rows):
    """(TICKER, entry_iso) -> row, dropping ambiguous duplicates.

    A duplicated ticker+entry cannot be resolved to one trade, so both are
    withheld rather than risk attaching a card to the wrong row.
    """
    seen = {}
    for r in rows:
        if len(r) < 6:
            continue
        ticker = (r[1] if len(r) > 1 else "").strip()
        if not ticker or ticker.lower() == "ticker":
            continue
        key = (ticker.upper(), _to_iso(r[4] if len(r) > 4 else ""))
        if not key[1]:
            continue
        seen.setdefault(key, []).append(r)
    out = {}
    for key, rs in seen.items():
        if len(rs) == 1:
            out[key] = rs[0]
        else:
            log("  ambiguous sheet rows for %s|%s (%d) -- skipped"
                % (key[0], key[1], len(rs)))
    return out


def _to_iso(d):
    d = (d or "").strip()
    if not d:
        return ""
    parts = d.split(".")
    if len(parts) == 3 and all(p.isdigit() for p in parts):
        return "%s-%s-%s" % (parts[2], parts[1].zfill(2), parts[0].zfill(2))
    return d[:10] if len(d) >= 10 and d[4] == "-" else ""


def _row_number(sheet_row_id, tab):
    """'Crypto:47' -> 47, or None when it does not name this tab."""
    prefix = tab + ":"
    if not str(sheet_row_id or "").startswith(prefix):
        return None
    tail = str(sheet_row_id)[len(prefix):]
    return int(tail) if tail.isdigit() else None


def build_sheet_arrays(positions, sheet_index, tab):
    """Sparse array whose index N-1 holds the live row for `Tab:N`.

    Only positions with an unambiguous live match are placed, so the builder's
    closed-only gate sees real sheet state and nothing else.
    """
    placed = {}
    for pos in positions:
        n = _row_number(pos.get("sheet_row_id"), tab)
        if not n:
            continue
        row = sheet_index.get((str(pos.get("ticker", "")).upper(),
                               ru_card_build.iso(pos.get("opened_at"))))
        if row is None:
            continue
        placed[n - 1] = row
    if not placed:
        return []
    size = max(placed) + 1
    data = [[""] * 11 for _ in range(size)]
    for i, row in placed.items():
        data[i] = list(row)
    return data


# --------------------------------------------------------------- supabase ---
def supabase_config():
    url = (os.environ.get("SUPABASE_URL") or "").strip().rstrip("/")
    # A dedicated read-only key is preferred; the service-role key is accepted
    # so the workflow also runs on an existing standard secret set.
    key = (os.environ.get("SUPABASE_CARD_EXPORT_KEY")
           or os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    return url, key


def fetch_positions(url, key, opener=None):
    """Closed positions with their RU lifecycle, sanitized at the boundary."""
    select = ("%s,%s(%s),%s(%s)"
              % (",".join(POSITION_FIELDS),
                 PARTIALS_REL, ",".join(PARTIAL_FIELDS),
                 EVENTS_REL, ",".join(EVENT_FIELDS + ("payload",))))
    endpoint = ("%s/rest/v1/%s?select=%s&status=eq.closed"
                % (url, POSITIONS_TABLE, urllib.parse.quote(select, safe="(),*")))
    get = opener or _http_get
    raw = get(endpoint, headers={"apikey": key,
                                 "Authorization": "Bearer " + key,
                                 "Accept": "application/json"})
    return [sanitize_position(p) for p in json.loads(raw)]


def _pick(src, fields):
    return {f: src.get(f) for f in fields if f in src}


def sanitize_position(raw):
    """Whitelist-only projection. Anything not named here is discarded."""
    pos = _pick(raw, POSITION_FIELDS)
    events = []
    for ev in (raw.get(EVENTS_REL) or []):
        if not ev.get("message_id_ru"):
            # Unpublished internal note: the builder would skip it anyway, and
            # dropping it here keeps unreviewed text out of the process.
            continue
        clean = _pick(ev, EVENT_FIELDS)
        clean["payload"] = _pick(ev.get("payload") or {}, PAYLOAD_FIELDS)
        events.append(clean)
    events.sort(key=lambda e: str(e.get("triggered_at") or ""))
    pos["events"] = events
    pos["partial_closes"] = [_pick(pc, PARTIAL_FIELDS)
                             for pc in (raw.get(PARTIALS_REL) or [])]
    return pos


# ------------------------------------------------------------------- main ---
def refresh(positions, sheets, manifest):
    """Apply the builder. Returns (n_written, added_keys)."""
    eq = build_sheet_arrays(positions, sheets["equities"], TAB["equities"])
    cr = build_sheet_arrays(positions, sheets["crypto"], TAB["crypto"])
    before = dict(manifest)
    written = ru_card_build.build(eq, cr, {"positions": positions}, manifest)
    for k, v in before.items():
        if manifest.get(k) != v:
            raise RuntimeError("refusing to clobber existing manifest entry: %s" % k)
    return written, sorted(k for k in manifest if k not in before)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would change without writing")
    args = ap.parse_args(argv)

    url, key = supabase_config()
    if not url or not key:
        log("Supabase credentials absent -- nothing to refresh.")
        log("Set SUPABASE_URL and SUPABASE_CARD_EXPORT_KEY (or "
            "SUPABASE_SERVICE_ROLE_KEY) to enable the rebuild.")
        _emit_changed(False)
        return 0

    log("fetching sheet rows")
    sheets = {}
    for name, gid in GIDS.items():
        rows = parse_rows(fetch_csv(gid))
        sheets[name] = index_sheet(rows)
        log("  %s: %d usable rows" % (name, len(sheets[name])))

    log("fetching closed positions from Supabase")
    positions = fetch_positions(url, key)
    log("  %d closed positions" % len(positions))

    with open(MANIFEST, encoding="utf-8") as f:
        manifest = json.load(f)
    original = json.dumps(manifest, ensure_ascii=False, separators=(",", ":"))

    written, added = refresh(positions, sheets, manifest)
    updated = json.dumps(manifest, ensure_ascii=False, separators=(",", ":"))

    if updated == original:
        log("no manifest change (%d cards already current)" % written)
        _emit_changed(False)
        return 0

    log("cards written/upgraded: %d; new keys: %d" % (written, len(added)))
    for k in added:
        log("  + %s" % k)
    if args.dry_run:
        log("dry run -- manifest not written")
        _emit_changed(False)
        return 0

    with open(MANIFEST, "w", encoding="utf-8") as f:
        f.write(updated)
    _emit_changed(True)
    return 0


def _emit_changed(changed):
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write("changed=%s\n" % ("true" if changed else "false"))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError,
            RuntimeError, KeyError) as exc:
        # Never echo the response body: it may carry production text.
        log("refresh failed: %s: %s" % (type(exc).__name__, str(exc)[:200]))
        sys.exit(1)

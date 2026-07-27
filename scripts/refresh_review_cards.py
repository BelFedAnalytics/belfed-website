#!/usr/bin/env python3
"""Post-close refresh for the RU review-card manifest.

Newly closed trades appear on the results pages the moment the Google Sheet is
updated, but their Review card stays on the generic no-timeline fallback until
`ru/trade_review_cards.json` is rebuilt. This script performs that rebuild
unattended so the gap closes on its own.

Two inputs, neither of which is ever written to the repo:

  * the same public Google Sheet CSV the pages already fetch (no credentials);
  * the token-gated `export_review_card_data` RPC, which returns only closed,
    archived positions and is already field-whitelisted server side.

The RPC is the only supported Supabase mode. It is reached with the publishable
key plus a separate export token, so this job never holds a service-role
credential and never needs to know the lifecycle table names.

The response is re-whitelisted here as well: English payloads, Telegram EN
message ids and every field not consumed by the card builder are dropped at the
boundary, so a raw production dump can never reach the manifest or the runner
log even if the server-side projection widens.

Row identity does NOT rely on CSV row alignment. The gviz export drops leading
header rows, so absolute spreadsheet row numbers are not recoverable from it.
Instead each Supabase position is matched to its sheet row by ticker + entry
date, and the matched row is placed at the index its own `sheet_row_id` names.
The builder's closed-only gate then runs against genuine sheet data. A position
with no unambiguous live match is skipped rather than guessed at.

Exit status: 0 on success (whether or not anything changed), 1 on any error --
including RPC auth rejection or a malformed payload. A failed run commits
nothing.
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

# The single Supabase entry point. The RPC owns the join and the projection, so
# no table or relation name is referenced from here.
RPC = "export_review_card_data"

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


def _http_post_json(url, headers, body):
    if not url.startswith("https://"):
        raise ValueError("refusing non-HTTPS request")
    payload = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers=headers,
                                 method="POST")
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
    """(url, publishable_key, export_token). Empty strings when unset.

    All three are required: the publishable key authenticates the request to
    PostgREST, the export token authorizes the RPC itself. There is no
    service-role path -- a key broad enough to read the raw tables must never
    be handed to this job.
    """
    url = (os.environ.get("SUPABASE_URL") or "").strip().rstrip("/")
    pub = (os.environ.get("SUPABASE_PUBLISHABLE_KEY") or "").strip()
    token = (os.environ.get("SUPABASE_CARD_EXPORT_KEY") or "").strip()
    return url, pub, token


def fetch_positions(url, pub_key, token, poster=None):
    """Closed positions with their RU lifecycle, via the token-gated RPC.

    Raises on auth rejection or on a payload that does not match the documented
    envelope, so a bad run fails loudly instead of quietly writing nothing.
    """
    endpoint = "%s/rest/v1/rpc/%s" % (url, RPC)
    post = poster or _http_post_json
    try:
        raw = post(endpoint,
                   {"apikey": pub_key,
                    "Content-Type": "application/json",
                    "Accept": "application/json"},
                   {"p_token": token})
    except urllib.error.HTTPError as exc:
        # Never surface the body: it can carry production text. The status alone
        # distinguishes a rejected token from an outage.
        if exc.code in (401, 403):
            raise RuntimeError(
                "RPC %s rejected the export token (HTTP %d) -- check "
                "SUPABASE_PUBLISHABLE_KEY and SUPABASE_CARD_EXPORT_KEY"
                % (RPC, exc.code))
        raise RuntimeError("RPC %s failed with HTTP %d" % (RPC, exc.code))
    return validate_envelope(raw)


def validate_envelope(raw):
    """Parse and re-whitelist `{generated_at, positions, events, partial_closes}`.

    The RPC already projects server side; this repeats the projection so a
    widened view cannot leak English copy or EN message ids into a committed
    file. Structural problems raise rather than silently yielding zero cards,
    which would look identical to a legitimate no-op.
    """
    try:
        env = json.loads(raw)
    except ValueError:
        raise RuntimeError("RPC %s returned a non-JSON body" % RPC)
    # PostgREST returns a single-row set for a scalar-returning function.
    if isinstance(env, list):
        if len(env) != 1 or not isinstance(env[0], dict):
            raise RuntimeError("RPC %s returned %d rows, expected 1"
                               % (RPC, len(env)))
        env = env[0]
    if not isinstance(env, dict):
        raise RuntimeError("RPC %s returned %s, expected an object"
                           % (RPC, type(env).__name__))
    if not env.get("generated_at"):
        raise RuntimeError("RPC %s payload has no generated_at" % RPC)
    for field in ("positions", "events", "partial_closes"):
        if not isinstance(env.get(field), list):
            raise RuntimeError("RPC %s payload field %r is not a list"
                               % (RPC, field))
    log("  export generated_at=%s" % env["generated_at"])

    events, partials = {}, {}
    for ev in env["events"]:
        if not ev.get("message_id_ru"):
            # Unpublished internal note: the builder would skip it anyway, and
            # dropping it here keeps unreviewed text out of the process.
            continue
        clean = _pick(ev, EVENT_FIELDS)
        clean["payload"] = _pick(ev.get("payload") or {}, PAYLOAD_FIELDS)
        events.setdefault(ev.get("position_id"), []).append(clean)
    for pc in env["partial_closes"]:
        partials.setdefault(pc.get("position_id"), []).append(
            _pick(pc, PARTIAL_FIELDS))

    out = []
    for raw_pos in env["positions"]:
        if not isinstance(raw_pos, dict):
            raise RuntimeError("RPC %s returned a non-object position" % RPC)
        for req in ("id", "ticker", "opened_at", "closed_at"):
            if not raw_pos.get(req):
                raise RuntimeError("position %r is missing %s"
                                   % (raw_pos.get("id"), req))
        pos = _pick(raw_pos, POSITION_FIELDS)
        pid = raw_pos["id"]
        pos["events"] = sorted(events.get(pid, []),
                               key=lambda e: str(e.get("triggered_at") or ""))
        pos["partial_closes"] = partials.get(pid, [])
        out.append(pos)
    return out


def _pick(src, fields):
    return {f: src.get(f) for f in fields if f in src}


# ------------------------------------------------------------------- main ---
def refresh(positions, sheets, manifest):
    """Apply the builder. Returns (n_written, added_keys)."""
    eq = build_sheet_arrays(positions, sheets["equities"], TAB["equities"])
    cr = build_sheet_arrays(positions, sheets["crypto"], TAB["crypto"])
    matched = sum(1 for d in (eq, cr) for r in d if len(r) > 1 and r[1])
    log("  positions matched to a live sheet row: %d of %d"
        % (matched, len(positions)))
    if positions and not matched:
        # Distinguishes a broken match from "everything already current": both
        # otherwise leave the manifest untouched and look like a clean no-op.
        raise RuntimeError("no position matched a live sheet row -- refusing to "
                           "treat a broken match as a no-op")
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

    url, pub_key, token = supabase_config()
    missing = [name for name, val in
               (("SUPABASE_URL", url), ("SUPABASE_PUBLISHABLE_KEY", pub_key),
                ("SUPABASE_CARD_EXPORT_KEY", token)) if not val]
    if missing:
        log("Supabase configuration absent -- nothing to refresh.")
        log("Missing: %s" % ", ".join(missing))
        _emit_changed(False)
        return 0

    log("fetching sheet rows")
    sheets = {}
    for name, gid in GIDS.items():
        rows = parse_rows(fetch_csv(gid))
        sheets[name] = index_sheet(rows)
        log("  %s: %d usable rows" % (name, len(sheets[name])))

    log("fetching closed positions via %s" % RPC)
    positions = fetch_positions(url, pub_key, token)
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

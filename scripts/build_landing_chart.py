#!/usr/bin/env python3
"""
Rebuild the BELFED_CHART_DATA JavaScript literal on the landing page.

Source of truth: public Google Sheet
  https://docs.google.com/spreadsheets/d/1bBpKZP74HEVrLZJlazz7gY7jbuBj9R5rPBcV2KklwDo/
  gid=0            → equities  (SPY benchmark)
  gid=1219794768   → crypto    (BTC benchmark)

The same sheet already powers trades.html / equities-trades.html on the
site, so the landing chart, the trade table, and the sheet are always in sync.

Benchmark prices come from yfinance (SPY, BTC-USD).

Equity model: start = $100,000, each closed trade with R = r multiplies equity
by (1 + 0.01 * r). R values come from column "Result" and already include the
trade's risk multiplier (0.5R, 1R, 2R, etc.) as authored on the sheet.

Also refreshes belfed-com's trades-fallback-*.json when --com-fallback is set,
so the static crypto table on belfed.com stays in sync too.

Idempotent: writes files only when content changes. Prints a summary.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

# ---------- Paths ----------

REPO_ROOT = Path(__file__).resolve().parent.parent
INDEX_HTML = REPO_ROOT / "index.html"

# ---------- Source ----------

SHEET_ID = "1bBpKZP74HEVrLZJlazz7gY7jbuBj9R5rPBcV2KklwDo"
SHEET_URL = (
    "https://docs.google.com/spreadsheets/d/{sid}/gviz/tq?"
    "tqx=out:csv&gid={gid}&single=true"
)
GID_EQUITIES = "0"
GID_CRYPTO = "1219794768"

BLOCK_RE = re.compile(
    r"var\s+BELFED_CHART_DATA\s*=\s*\{.*?\}\s*;",
    re.DOTALL,
)

# Columns we consume (indices are stable in the current sheet layout):
COL_TICKER    = 1
COL_DIRECTION = 2
COL_STATUS    = 3
COL_ENTRY_DT  = 4
COL_EXIT_DT   = 5
COL_ENTRY_PX  = 6
COL_RISK_PX   = 7
COL_EXIT_PX   = 8
COL_RESULT    = 9
COL_TV_LINK   = 10
COL_COMMENT   = 13

# Public "Fallback JSON" schema on belfed.com (11 fixed columns):
FALLBACK_HEADER = [
    "#", "Ticker", "Direction", "Status", "Entry Date", "Exit Date",
    "Entry", "Risk", "Exit", "Result", "TVlink",
]

# ---------- Small helpers ----------

def _parse_number(s):
    if s is None:
        return None
    s = str(s).strip().replace("\xa0", "").replace(" ", "").replace(",", ".")
    if s == "":
        return None
    try:
        return float(s)
    except ValueError:
        return None

def _parse_date(s):
    if not s:
        return None
    s = str(s).strip()
    if not s:
        return None
    try:
        d, m, y = s.split(".")
        return date(int(y), int(m), int(d))
    except (ValueError, AttributeError):
        return None

def _http_get(url: str, timeout: int = 30) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "belfed-landing-builder/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8")

# ---------- Load from Google Sheet ----------

def fetch_sheet(gid: str) -> list[list[str]]:
    url = SHEET_URL.format(sid=SHEET_ID, gid=gid)
    text = _http_get(url)
    return list(csv.reader(io.StringIO(text)))

def find_header_row(rows: list[list[str]]) -> int:
    for i, r in enumerate(rows):
        cells = [c.strip() for c in r]
        # Sheet quirks:
        #  * equities: row 2 starts with ['Number', 'Ticker', 'Direction', 'Status', ...]
        #  * crypto:   row 0 has ['... Number', 'Ticker', 'Direction', 'Status', ...]
        #    (title 'Belfed Analytics Trades | Crypto' pre-pended to first cell).
        if len(cells) <= COL_STATUS:
            continue
        first = cells[0].split()[-1] if cells[0] else ""
        if (first == "Number"
            and cells[COL_TICKER] == "Ticker"
            and cells[COL_STATUS] == "Status"):
            return i
    raise SystemExit("Cannot find header row (Number/Ticker/Status) in sheet")

def sheet_trades(rows: list[list[str]]):
    """Return list of (exit_date, r) for rows with Status == 'Closed'."""
    hi = find_header_row(rows)
    trades = []
    for row in rows[hi + 1:]:
        if len(row) <= COL_RESULT:
            continue
        status = (row[COL_STATUS] or "").strip().lower()
        if status != "closed":
            continue
        r = _parse_number(row[COL_RESULT])
        if r is None:
            continue
        d = _parse_date(row[COL_EXIT_DT])
        if d is None:
            continue
        trades.append((d, r))
    trades.sort(key=lambda t: t[0])
    return trades

def sheet_public_table(rows: list[list[str]]):
    """Return a list-of-lists in the same shape as belfed-com's trades-fallback-*.json.
    First element is FALLBACK_HEADER; subsequent rows keep sheet ordering."""
    hi = find_header_row(rows)
    out = [FALLBACK_HEADER[:]]
    for row in rows[hi + 1:]:
        if len(row) <= COL_RESULT:
            continue
        ticker = (row[COL_TICKER] or "").strip()
        status = (row[COL_STATUS] or "").strip()
        if not ticker or not status:
            continue
        # Trailing extras (Comment etc) preserved beyond the fixed 11-col header,
        # matching the current fallback JSON style.
        rec = [
            "",
            ticker,
            (row[COL_DIRECTION] or "").strip(),
            status,
            (row[COL_ENTRY_DT] or "").strip(),
            (row[COL_EXIT_DT] or "").strip(),
            (row[COL_ENTRY_PX] or "").strip(),
            (row[COL_RISK_PX] or "").strip(),
            (row[COL_EXIT_PX] or "").strip(),
            (row[COL_RESULT] or "").strip(),
            (row[COL_TV_LINK] or "").strip() if len(row) > COL_TV_LINK else "",
        ]
        # Optional trailing columns present in the current file (empty, empty, comment)
        rec.extend([
            "",
            "",
            (row[COL_COMMENT] or "").strip() if len(row) > COL_COMMENT else "",
        ])
        out.append(rec)
    return out

# ---------- Equity curve ----------

RISK_PER_TRADE = 0.01  # 1% risk-per-R, compounded

def build_equity_curve(trades, start_dt: date, end_dt: date, initial: float = 100000.0):
    total_days = (end_dt - start_dt).days
    curve_by_day = {}
    equity = initial
    for d, r in trades:
        equity *= (1 + RISK_PER_TRADE * r)
        curve_by_day[d] = equity  # last write per day
    result = [[0, round(initial)]]
    running = initial
    for day in range(1, total_days + 1):
        dt = start_dt + timedelta(days=day)
        if dt in curve_by_day:
            running = curve_by_day[dt]
        result.append([day, round(running)])
    return result

# ---------- Benchmark ----------

_yf = None

def _yfinance():
    global _yf
    if _yf is None:
        try:
            import yfinance as yf  # noqa
        except ImportError:
            raise SystemExit("yfinance is required. pip install yfinance")
        _yf = yf
    return _yf

def fetch_benchmark(symbol: str, start_dt: date, end_dt: date):
    yf = _yfinance()
    df = yf.download(
        symbol,
        start=start_dt.isoformat(),
        end=(end_dt + timedelta(days=1)).isoformat(),
        auto_adjust=True,
        progress=False,
    )
    if df is None or df.empty:
        raise SystemExit(f"yfinance returned empty data for {symbol}")
    if hasattr(df.columns, "get_level_values") and df.columns.nlevels > 1:
        close = df["Close"][symbol]
    else:
        close = df["Close"]
    close = close.dropna()
    if close.empty:
        raise SystemExit(f"{symbol}: no non-NaN closes")
    base = float(close.iloc[0])
    if base == 0:
        raise SystemExit(f"{symbol}: base price is zero")
    points = []
    seen = set()
    max_off = (end_dt - start_dt).days
    for ts, price in close.items():
        py = ts.date() if hasattr(ts, "date") else ts
        offset = (py - start_dt).days
        if offset < 0 or offset > max_off or offset in seen:
            continue
        seen.add(offset)
        points.append([offset, round(100000.0 * float(price) / base)])
    return points

# ---------- Aggregate ----------

def compute_dataset(trades, start_dt: date, end_dt: date, bench_points, bench_display: str):
    n = len(trades)
    wins = sum(1 for _, r in trades if r > 0)
    win_rate = round(100 * wins / n, 1) if n else 0.0
    total_r = round(sum(r for _, r in trades), 2)
    belfed_pts = build_equity_curve(trades, start_dt, end_dt)
    belfed_return = round((belfed_pts[-1][1] / belfed_pts[0][1] - 1) * 100, 1)
    bench_return = 0.0
    if bench_points:
        bench_return = round((bench_points[-1][1] / bench_points[0][1] - 1) * 100, 1)
    return {
        "belfed": belfed_pts,
        "benchmark": bench_points,
        "bench_name": bench_display,
        "start_date": start_dt.isoformat(),
        "end_date": end_dt.isoformat(),
        "total_days": (end_dt - start_dt).days,
        "total_r": total_r,
        "n_trades": n,
        "wins": wins,
        "win_rate": win_rate,
        "belfed_return": belfed_return,
        "bench_return": bench_return,
    }

def _filter(trades, s: date, e: date):
    return [(d, r) for d, r in trades if s <= d <= e]

def build_all():
    print("Fetching Google Sheet (equities) ...", flush=True)
    eq_rows = fetch_sheet(GID_EQUITIES)
    print("Fetching Google Sheet (crypto)   ...", flush=True)
    cr_rows = fetch_sheet(GID_CRYPTO)

    eq_trades = sheet_trades(eq_rows)
    cr_trades = sheet_trades(cr_rows)
    if not eq_trades or not cr_trades:
        raise SystemExit("Sheet did not yield any closed trades. Aborting.")

    last_exit = max(eq_trades[-1][0], cr_trades[-1][0])

    windows = {
        "eq_2025": (date(2025, 1, 1), date(2025, 12, 31), "SPY",     "SPY", eq_trades),
        "eq_2026": (date(2026, 1, 1), last_exit,          "SPY",     "SPY", eq_trades),
        "eq_all":  (date(2025, 1, 1), last_exit,          "SPY",     "SPY", eq_trades),
        "cr_2025": (date(2025, 1, 1), date(2025, 12, 31), "BTC-USD", "BTC", cr_trades),
        "cr_2026": (date(2026, 1, 1), last_exit,          "BTC-USD", "BTC", cr_trades),
        "cr_all":  (date(2025, 1, 1), last_exit,          "BTC-USD", "BTC", cr_trades),
    }

    bench_cache = {}
    def bench(symbol, s, e):
        key = (symbol, s, e)
        if key not in bench_cache:
            print(f"Fetching benchmark {symbol} {s} .. {e} ...", flush=True)
            bench_cache[key] = fetch_benchmark(symbol, s, e)
        return bench_cache[key]

    data = {}
    for label, (s, e, sym, display, universe) in windows.items():
        data[label] = compute_dataset(_filter(universe, s, e), s, e,
                                      bench(sym, s, e), display)
    fallback = {
        "equities": sheet_public_table(eq_rows),
        "crypto":   sheet_public_table(cr_rows),
    }
    return data, fallback

# ---------- Splice ----------

def render_literal(data: dict) -> str:
    return ("var BELFED_CHART_DATA = "
            + json.dumps(data, separators=(",", ":"), ensure_ascii=False)
            + ";")

def splice_html(html: str, literal: str) -> str:
    if not BLOCK_RE.search(html):
        raise SystemExit("Could not locate BELFED_CHART_DATA block in index.html")
    return BLOCK_RE.sub(lambda _m: literal, html, count=1)

def write_if_changed(path: Path, new_content: str) -> bool:
    old = path.read_text(encoding="utf-8") if path.exists() else ""
    if old == new_content:
        return False
    path.write_text(new_content, encoding="utf-8")
    return True

# ---------- CLI ----------

def main():
    ap = argparse.ArgumentParser(description="Rebuild landing chart from Google Sheet.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print stats, do not write anything")
    ap.add_argument("--check", action="store_true",
                    help="Exit 1 if any target file would change")
    ap.add_argument("--com-fallback", action="store_true",
                    help="Also write trades-fallback-*.json (used on belfed.com only)")
    args = ap.parse_args()

    data, fallback = build_all()

    # Landing chart literal
    literal = render_literal(data)
    html = INDEX_HTML.read_text(encoding="utf-8")
    new_html = splice_html(html, literal)
    html_changed = new_html != html

    # Optional fallback JSON files (belfed.com only)
    files_changed = []
    if args.com_fallback:
        eq_path = REPO_ROOT / "trades-fallback-equities.json"
        cr_path = REPO_ROOT / "trades-fallback-crypto.json"
        eq_new = json.dumps(fallback["equities"], ensure_ascii=False, indent=2) + "\n"
        cr_new = json.dumps(fallback["crypto"],   ensure_ascii=False, indent=2) + "\n"
        eq_old = eq_path.read_text(encoding="utf-8") if eq_path.exists() else ""
        cr_old = cr_path.read_text(encoding="utf-8") if cr_path.exists() else ""
        if eq_new != eq_old:
            files_changed.append(eq_path)
        if cr_new != cr_old:
            files_changed.append(cr_path)

    print("=== BELFED_CHART_DATA rebuilt ===")
    print("Source: Google Sheet (equities gid=0, crypto gid=1219794768)")
    print("Bench:  yfinance SPY + BTC-USD")
    for k, v in data.items():
        print(
            f"  {k:8s}  n={v['n_trades']:3d}  win_rate={v['win_rate']:5.1f}%  "
            f"total_R={v['total_r']:7.2f}  belfed={v['belfed_return']:7.1f}%  "
            f"bench={v['bench_return']:6.1f}%  ({v['start_date']} → {v['end_date']})"
        )
    print(f"index.html would change: {html_changed}")
    if args.com_fallback:
        print(f"fallback files that would change: {[p.name for p in files_changed]}")

    any_change = html_changed or bool(files_changed)

    if args.check:
        sys.exit(1 if any_change else 0)
    if args.dry_run:
        return

    if html_changed:
        INDEX_HTML.write_text(new_html, encoding="utf-8")
        print(f"Wrote {INDEX_HTML}")
    if args.com_fallback:
        for path in files_changed:
            path.write_text(
                (eq_new if path.name == "trades-fallback-equities.json" else cr_new),
                encoding="utf-8",
            )
            print(f"Wrote {path}")
    if not any_change:
        print("No changes.")

if __name__ == "__main__":
    main()

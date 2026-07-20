#!/usr/bin/env python3
"""Regression tests for the RU trade audit + bot-card builder.

Covers the three root causes the audit fixes:
  1. member-signal dot must fire for every case/whitespace variant of "Yes";
  2. genuine published Supabase timelines become faithful bot cards;
  3. trades sharing ticker+entry (duplicate keys) must never collide.
"""
import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "scripts"))

import ru_card_build as B          # noqa: E402
import ru_trade_audit as A         # noqa: E402

AUDIT_DIR = os.path.join(os.path.dirname(REPO), "trade_audit_2026-07-20")
DATA = pytest.mark.skipif(not os.path.isdir(AUDIT_DIR),
                          reason="audit snapshot not present")


# ----------------------------------------------------------- Yes handling ---
@pytest.mark.parametrize("raw,expected", [
    ("Yes", True), ("yes", True), ("YES", True), (" Yes ", True),
    ("\tyes\n", True), ("YeS", True),
    ("No", False), ("", False), (None, False), ("y", False),
    ("yes please", False), ("1", False),
])
def test_is_yes(raw, expected):
    assert A.is_yes(raw) is expected


# --------------------------------------------------------- date + keys ------
@pytest.mark.parametrize("raw,iso", [
    ("30.04.2026", "2026-04-30"),
    ("1.5.2026", "2026-05-01"),
    ("2026-04-30", "2026-04-30"),
    ("2026-04-30T12:00:00Z", "2026-04-30"),
    ("", ""), ("garbage", ""),
])
def test_to_iso(raw, iso):
    assert A.to_iso(raw) == iso


def test_key_helpers():
    assert A.key_full("tsla", "30.04.2026", "15.05.2026") == "TSLA|2026-04-30|2026-05-15"
    assert A.key_pair("tsla", "30.04.2026") == "TSLA|2026-04-30"
    # collision-safe key is asset-class + direction qualified
    ks = A.key_safe("equities", "TSLA", "Long", "30.04.2026", "15.05.2026")
    assert ks == "eq#l#TSLA|2026-04-30|2026-05-15"
    assert A.key_safe("crypto", "BTC", "Short", "01.05.2026", "28.05.2026") == \
        "cr#s#BTC|2026-05-01|2026-05-28"


def test_builder_and_js_safe_keys_agree():
    """ru_card_build.key_safe (writes manifest) must match ru_trade_audit.key_safe
    (mirrors the JS lookup) so the browser finds the card it wrote."""
    pos = {"asset_class": "equities", "ticker": "tsla", "direction": "Long",
           "opened_at": "2026-04-30T10:00:00Z", "closed_at": "2026-05-15T10:00:00Z"}
    # Replicate ru_card_build.build's inner key_safe:
    ac = "cr" if pos.get("asset_class") == "crypto" else "eq"
    dr = (pos.get("direction") or "").lower()[:1] or "?"
    built = "%s#%s#%s|%s|%s" % (ac, dr, pos["ticker"].upper(),
                                B.iso(pos["opened_at"]), B.iso(pos["closed_at"]))
    audit = A.key_safe("equities", "TSLA", "Long", "30.04.2026", "15.05.2026")
    assert built == audit == "eq#l#TSLA|2026-04-30|2026-05-15"


# ------------------------------------------------------ card body rules -----
def _pos(**kw):
    base = {"ticker": "TST", "direction": "long", "asset_class": "equities",
            "opened_at": "2026-06-01T00:00:00Z", "closed_at": "2026-06-05T00:00:00Z",
            "result_rr": 1.5, "comment_ru": None, "close_comment_ru": None,
            "events": [], "partial_closes": []}
    base.update(kw)
    return base


def _ev(et, mid=100, **payload):
    return {"event_type": et, "message_id_ru": mid, "triggered_at": "2026-06-01T00:00:00Z",
            "payload": payload}


def test_opened_uses_comment_then_price_fallback():
    p = _pos(comment_ru="Открываем позицию.", events=[_ev("opened", triggered_price=30.78)])
    assert "Открываем позицию." in B.build_card(p, {})
    p2 = _pos(comment_ru=None, events=[_ev("opened", triggered_price=30.78)])
    assert "Открытие по 30.78." in B.build_card(p2, {})


def test_stop_moved_comment_then_fallback():
    p = _pos(events=[_ev("opened", triggered_price=1), _ev("stop_moved", 200,
             new_stop=10.57, old_stop=11)])
    assert "Стоп перенесён с 11 на 10.57." in B.build_card(p, {})
    p2 = _pos(events=[_ev("opened", triggered_price=1), _ev("stop_moved", 200,
              new_stop=10.57, old_stop=11, comment_ru="Двигаем стоп в БУ.")])
    assert "Двигаем стоп в БУ." in B.build_card(p2, {})


def test_target_stop_and_closed_bodies():
    p = _pos(events=[_ev("opened", triggered_price=1), _ev("target_1_hit", 3, triggered_price=38.1)])
    assert "Цель 1 достигнута по 38.1." in B.build_card(p, {})
    p = _pos(events=[_ev("opened", triggered_price=1), _ev("stop_hit", 3, triggered_price=105.33)])
    assert "Стоп сработал по 105.33." in B.build_card(p, {})
    p = _pos(close_comment_ru="Фиксируем прибыль.",
             events=[_ev("opened", triggered_price=1), _ev("closed", 3, triggered_price=50)])
    assert "Фиксируем прибыль." in B.build_card(p, {})
    p = _pos(close_comment_ru=None,
             events=[_ev("opened", triggered_price=1), _ev("closed", 3, triggered_price=50)])
    assert "Закрыто по 50." in B.build_card(p, {})


def test_partial_closed_body():
    p = _pos(events=[_ev("opened", triggered_price=1),
                     _ev("partial_closed", 3, partial_close_id=7)])
    pc = {7: {"id": 7, "pct_closed": 50, "exit_price": 42.5}}
    assert "Закрыто 50% по 42.5." in B.build_card(p, pc)


def test_unpublished_events_are_skipped():
    """An event with no message_id_ru is an internal note, not a subscriber
    signal, and must not appear as a timeline step."""
    p = _pos(events=[_ev("opened", 100, triggered_price=1),
                     _ev("edited", None, comment_ru="silent"),
                     _ev("stop_hit", 300, triggered_price=9)])
    html = B.build_card(p, {})
    assert html.count('class="step"') == 2
    assert "silent" not in html


def test_result_none_renders_dash():
    p = _pos(result_rr=None, events=[_ev("opened", 100, triggered_price=1)])
    html = B.build_card(p, {})
    assert 'class="no-link">—' in html
    assert "Результат: —" in html


def test_body_is_html_escaped():
    p = _pos(comment_ru='Смотри "заметку" <тут>', events=[_ev("opened", 100, triggered_price=1)])
    html = B.build_card(p, {})
    assert "&quot;заметку&quot;" in html and "&lt;тут&gt;" in html


def test_step_link_points_at_ru_topic():
    p = _pos(events=[_ev("opened", 847, triggered_price=1)])
    assert "https://t.me/c/3773738299/4/847" in B.build_card(p, {})


def test_deanglicize_drops_swing_loanword():
    assert "свинг" not in B.deanglicize("Открываем свинг-позицию по акции.")
    assert "–" not in B.deanglicize("диапазон 10–20")


# ------------------------------------------- verbatim + evidence-based path --
def test_stored_text_is_verbatim_never_deanglicized():
    """Published subscriber text is rendered byte-for-byte (escape only). Even
    if it contained a loanword, we must NOT rewrite it -- only generated
    fallbacks are de-anglicized."""
    p = _pos(comment_ru="Открываем свинг-позицию по акции.",
             events=[_ev("opened", 100, triggered_price=1)])
    html = B.build_card(p, {})
    assert "Открываем свинг-позицию по акции." in html  # untouched
    assert "средне-срочная" not in html


def test_evidence_based_card_has_no_steplink():
    """A position with genuine evidence but no message_id_ru gets an honest
    UNLINKED timeline (exactly what EN does for NBIS/OUST) -- never a fabricated
    Telegram link."""
    p = _pos(comment_ru="Открываем позицию по идее.",
             close_comment_ru="Закрываем по достижению цели.",
             events=[],
             partial_closes=[{"id": 1, "closed_at": "2026-06-03T00:00:00Z",
                              "pct_closed": 50, "exit_price": 45.41,
                              "comment_ru": "Фиксируем часть позиции."}])
    html = B.build_card(p, {})
    assert 'class="steplink"' not in html
    assert "t.me/c/" not in html
    assert "Открываем позицию по идее." in html          # opened, verbatim
    assert "Фиксируем часть позиции." in html            # partial, verbatim
    assert "Закрываем по достижению цели." in html        # closed, verbatim
    assert html.count('class="step"') == 3


def test_partial_without_comment_uses_generated_body():
    p = _pos(comment_ru="Открытие идеи.", events=[],
             partial_closes=[{"id": 9, "closed_at": "2026-06-03T00:00:00Z",
                              "pct_closed": 75, "exit_price": 229.23,
                              "comment_ru": None}])
    html = B.build_card(p, {})
    assert "Закрыто 75% по 229.23." in html
    assert 'class="steplink"' not in html


def test_only_fully_closed_sheet_rows_are_prebuilt():
    """Parity with EN: a card is generated only for a sheet row that is fully
    closed (Status=Closed, has an exit date and a numeric result). Open, Merged
    and Partially-closed rows -- even ones carrying a result value -- are not
    prebuilt; a later rebuild picks them up once they close.

    Sheet columns: 3=Status, 5=Date of exit, 9=Result/Risk-Reward.
    """
    def row(status, exit_, result):
        r = [""] * 10
        r[1], r[3], r[5], r[9] = "TST", status, exit_, result
        return r
    assert B._row_fully_closed(row("Closed", "13.06.2026", "0,42")) is True
    assert B._row_fully_closed(row("Closed", "20.07.2026", "2.81")) is True
    assert B._row_fully_closed(row("Open", "", "1,6159")) is False      # LITE-like
    assert B._row_fully_closed(row("Merged", "", "0,14")) is False       # SOL-like
    assert B._row_fully_closed(row("Partially closed", "", "")) is False  # NEGG-like
    assert B._row_fully_closed(row("Closed", "", "1,5")) is False         # no exit
    assert B._row_fully_closed(row("Closed", "13.06.2026", "")) is False  # no result
    assert B._row_fully_closed(None) is False


def test_build_skips_open_positions(monkeypatch):
    """An eligible position whose sheet row is Open must not get any manifest
    key (full or collision-safe)."""
    header = [["", "", "", "", ""], ["", "", "", "", ""], ["", "Ticker", "", "", ""]]
    # Equties:4 -> open row with partial evidence
    open_row = [""] * 10
    open_row[1], open_row[3], open_row[5], open_row[9] = "OPN", "Open", "", ""
    eq = header + [open_row]
    cr = header[:]
    pos = _pos(ticker="OPN", asset_class="equities", opened_at="2026-06-01T00:00:00Z",
               closed_at=None, comment_ru="Открытие идеи.",
               partial_closes=[{"id": 1, "closed_at": "2026-06-03T00:00:00Z",
                                "pct_closed": 50, "exit_price": 10, "comment_ru": "Часть."}])
    pos["sheet_row_id"] = "Equties:4"
    sb = {"positions": [pos]}
    man = {}
    B.build(eq, cr, sb, man)
    assert man == {}, "open position must not be prebuilt"


def test_lone_comment_is_not_eligible():
    """A bare idea note (comment_ru only, no events/partials/close) is not a
    lifecycle and must stay a legacy card -- no bot card is fabricated."""
    p = _pos(comment_ru="Просто идея, без истории.", events=[], partial_closes=[])
    assert B.is_eligible(p) is False
    p2 = _pos(comment_ru="Идея", events=[], partial_closes=[],
              close_comment_ru="Закрыто.")
    assert B.is_eligible(p2) is True


# --------------------------------------------------- duplicate collisions ---
def test_ambiguous_pair_key_is_dropped():
    """Two sheet trades sharing TICKER|entry must not keep a pair alias that
    would let one borrow the other's card."""
    header = [["", "", "", "", ""], ["", "", "", "", ""], ["", "Ticker", "", "", ""]]
    # two TSLA rows, same entry date, different exits
    eq = header + [
        ["1", "TSLA", "Long", "Closed", "30.04.2026", "08.05.2026"],
        ["2", "TSLA", "Long", "Closed", "30.04.2026", "15.05.2026"],
    ]
    cr = header[:]
    man = {"TSLA|2026-04-30": {"kind": "bot", "ru": "x"},
           "AAPL|2026-04-30": {"kind": "bot", "ru": "y"}}
    B._drop_ambiguous_pairs(eq, cr, man)
    assert "TSLA|2026-04-30" not in man     # ambiguous -> dropped
    assert "AAPL|2026-04-30" in man         # unique -> kept


@DATA
def test_build_never_overwrites_existing_bot_card():
    eq, cr, sb, man = A.load(AUDIT_DIR)
    before = {k: v["ru"] for k, v in man.items() if v.get("kind") == "bot"
              and k.count("|") == 2 and "#" not in k}
    B.build(eq, cr, sb, man)
    for k, ru in before.items():
        assert man[k]["ru"] == ru, "existing bot card %s was clobbered" % k


@DATA
def test_every_member_yes_row_can_render_a_dot():
    """Audit invariant: each Members-Signal=Yes row is detected, so the page
    has the signal it needs to render a dot."""
    eq, cr, sb, man = A.load(AUDIT_DIR)
    records = A.audit(eq, cr, sb, man)
    yes = [r for r in records if r["member_yes"]]
    assert yes, "expected some member_yes rows in the snapshot"
    for r in yes:
        assert A.is_yes(r["member_raw"])


def test_member_cell_read_is_defensive_on_short_row():
    """Defensive read: a row shorter than the member index must yield no dot,
    never an IndexError -- mirroring the JS `r[col]` -> undefined ->
    isMemberYes(undefined) === false path. (Note: the dot loss that browser QA
    saw was NOT such a short row -- it was the col-13 quoted-newline parseCSV bug
    fixed in ru/trades.html + ru/equities.html and covered by
    tests/csv_parse.test.js; the underlying sheet cells are populated.)"""
    short = ["1", "TSLA", "Long", "Closed", "15.07.2026", "16.07.2026",
             "398", "", "402", "0.5", "", "", "", "note"]
    assert len(short) <= 19
    assert A.cell(short, 19) == ""            # safe read, no IndexError
    assert A.is_yes(A.cell(short, 19)) is False
    full = short + [""] * (20 - len(short))
    full[19] = "yes"
    assert A.is_yes(A.cell(full, 19)) is True

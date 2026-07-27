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


# ------------------------------------- LITE #237 post-close rebuild (Equties:167) --
# Regression for the missing-history bug: position 237 (LITE) was OPEN during the
# 2026-07-20 closed-only manifest build, closed 2026-07-21, and no rebuild ran --
# so live RU showed the generic fallback instead of its published bot timeline.
# Fixture mirrors trade_audit_2026-07-22/lite_source.json (SQL `partials` field
# normalised to the snapshot's `partial_closes`). Verbatim RU is preserved,
# including the author's own English parenthetical; EN payloads never leak.
LITE_OPENED_RU = ("Цена продолжает формировать более низкие максимумы (lower highs) "
                  "и сегодня резко реагирует на важной зоны сопротивления в районе "
                  "ключевых средних, что указывает на продолжающуюся дистрибуцию.")
LITE_OPENED_EN = "Price continues to print lower highs and is reacting sharply"
LITE_STOP_RU = ("Смещаем уровень риска на вчерашние максимумы. Чтобы сохранить высокую "
                "вероятность продолжения коррекции в ближайшие недели, цена должна "
                "удержаться ниже этой отметки и продолжить закрываться под скользящими "
                "средними.")
LITE_STOP_EN = "Shifting the risk level to yesterday's highs."


def _lite237():
    return {
        "ticker": "LITE", "direction": "short", "asset_class": "stock",
        "opened_at": "2026-06-25T15:22:14.812229+00:00",
        "closed_at": "2026-07-21T17:50:03.449+00:00",
        "exit_price": 839, "result_rr": 1.6189,
        "comment_ru": LITE_OPENED_RU, "comment_en": LITE_OPENED_EN,
        "close_comment_ru": None, "close_comment_en": None,
        "sheet_row_id": "Equties:167",
        "events": [
            {"event_type": "opened", "message_id_ru": 965, "message_id_en": 992,
             "triggered_at": "2026-06-25T15:22:26+00:00",
             "payload": {"event": "opened", "is_addon": False, "triggered_price": 838.76}},
            {"event_type": "target_1_hit", "message_id_ru": 1035, "message_id_en": 1065,
             "triggered_at": "2026-07-02T17:50:07+00:00",
             "payload": {"triggered_price": 714.72}},
            {"event_type": "stop_moved", "message_id_ru": 1148, "message_id_en": 1178,
             "triggered_at": "2026-07-15T13:44:46+00:00",
             "payload": {"new_stop": 839, "old_stop": 838.76,
                         "comment_ru": LITE_STOP_RU, "comment_en": LITE_STOP_EN}},
            {"event_type": "target_2_hit", "message_id_ru": 1200, "message_id_en": 1228,
             "triggered_at": "2026-07-17T13:45:05+00:00",
             "payload": {"triggered_price": 653.19}},
            {"event_type": "stop_hit", "message_id_ru": 1238, "message_id_en": 1266,
             "triggered_at": "2026-07-21T17:50:05+00:00",
             "payload": {"triggered_price": 839}},
        ],
        "partial_closes": [
            {"id": 48, "closed_at": "2026-07-02T17:50:06+00:00", "exit_price": 714.72,
             "pct_closed": 35, "comment_ru": "Auto target_1_hit", "source": "bot"},
            {"id": 59, "closed_at": "2026-07-17T13:45:04+00:00", "exit_price": 653.19,
             "pct_closed": 35, "comment_ru": "Auto target_2_hit", "source": "bot"},
            {"id": 63, "closed_at": "2026-07-21T17:50:03+00:00", "exit_price": 839,
             "pct_closed": 30, "comment_ru": "Auto stop_hit", "source": "bot"},
        ],
    }


def test_lite237_full_published_timeline():
    """All five published RU events become linked steps, in message order, with
    the correct t.me/c/<RU_CHANNEL>/<RU_TOPIC>/<id> links."""
    p = _lite237()
    assert B.is_eligible(p) is True
    pc_by_id = {pc["id"]: pc for pc in p["partial_closes"]}
    html = B.build_card(p, pc_by_id)

    assert html.count('class="step"') == 5
    assert html.count('class="steplink"') == 5
    for mid in (965, 1035, 1148, 1200, 1238):
        assert ("https://t.me/c/3773738299/4/%d" % mid) in html
    # meta: short direction, +1.62R (rounded from 1.6189), exit 839
    assert "badge-short" in html
    assert "+1.62R" in html
    assert "Выход: 839" in html


def test_lite237_verbatim_ru_no_english_payload_leak():
    """Stored RU text is byte-for-byte (incl. the author's '(lower highs)'
    parenthetical); the parallel comment_en payloads must never render."""
    p = _lite237()
    html = B.build_card(p, {pc["id"]: pc for pc in p["partial_closes"]})
    assert "более низкие максимумы (lower highs)" in html       # opened, verbatim
    assert "Смещаем уровень риска на вчерашние максимумы." in html  # stop_moved, verbatim
    assert LITE_OPENED_EN not in html
    assert LITE_STOP_EN not in html
    assert "3869302680" not in html                            # EN channel id never leaks


def test_lite237_generated_fallbacks_for_unwritten_events():
    """Events with no stored comment (targets, stop_hit) get de-anglicized RU
    fallbacks from the payload price."""
    p = _lite237()
    html = B.build_card(p, {pc["id"]: pc for pc in p["partial_closes"]})
    assert "Цель 1 достигнута по 714.72." in html
    assert "Цель 2 достигнута по 653.19." in html
    assert "Стоп сработал по 839." in html


def _eq_sheet_with_lite(status, exit_, result):
    """Equties sheet whose row 167 (index 166) is the LITE trade."""
    header = [["", "", "", "", ""], ["", "", "", "", ""], ["", "Ticker", "", "", ""]]
    filler = [[""] * 2 for _ in range(163)]        # rows 4..166 -> skipped (blank ticker)
    lite = ["160", "LITE", "Short", status, "25.06.2026", exit_,
            "838.76", "906", "839", result]
    eq = header + filler + [lite]
    assert len(eq) == 167                          # LITE lands on Equties:167
    return eq


def test_lite237_prebuilt_only_after_close():
    """Closed-only policy preserved: LITE resolves to a bot card under both the
    full and collision-safe keys once its sheet row is Closed with an exit and a
    numeric result -- and is NOT prebuilt while that row is still Open."""
    kf = "LITE|2026-06-25|2026-07-21"
    ks = "eq#s#LITE|2026-06-25|2026-07-21"

    # Open row (the pre-close state): nothing prebuilt.
    eq_open = _eq_sheet_with_lite("Open", "", "")
    assert B._row_fully_closed(eq_open[166]) is False
    man = {}
    B.build(eq_open, [], {"positions": [_lite237()]}, man)
    assert kf not in man and ks not in man

    # Closed row (post-close rebuild): bot card written under both keys.
    eq_closed = _eq_sheet_with_lite("Closed", "21.07.2026", "1,62")
    assert B._row_fully_closed(eq_closed[166]) is True
    man = {}
    B.build(eq_closed, [], {"positions": [_lite237()]}, man)
    assert man.get(kf, {}).get("kind") == "bot"
    assert man.get(ks, {}).get("kind") == "bot"
    assert man[kf]["ru"] == man[ks]["ru"]
    assert man[kf]["ru"].count('class="step"') == 5


def test_lite237_present_in_committed_manifest():
    """The production manifest carries the rebuilt LITE bot timeline under both
    keys (guards against a future rebuild dropping it)."""
    with open(A.MANIFEST) as f:
        m = json.load(f)
    for k in ("LITE|2026-06-25|2026-07-21", "eq#s#LITE|2026-06-25|2026-07-21"):
        assert m.get(k, {}).get("kind") == "bot", "missing LITE key %s" % k
        assert m[k]["ru"].count('class="step"') == 5


# --------------------------------- CL #331 / ETH #337 post-close rebuild -----
# Regression for the same missing-history class of bug as LITE #237, for the two
# crypto trades that closed after the 2026-07-20 snapshot: CL (Crypto:47, long,
# closed 2026-07-27) and ETH (Crypto:49, short, closed 2026-07-26). Both showed
# the generic fallback because no rebuild ran after they closed. Fixtures mirror
# the verified production lifecycle; only RU message ids are ever linked.
CL331_OPENED_RU = ("Цена, вероятно, формирует локальное дно в целевой зоне поддержки 71-70 "
                   "перед следующим импульсом вверх к 78-80. Открываем длинную позицию по "
                   "CL на криптобирже. Стоп-лосс размещаем под минимумом сегодняшней "
                   "сессии. По возможной общей структуре тренда смотри наш недавний анализ "
                   "по USO: https://t.me/c/3773738299/2/1091")

CL331_PARTIAL_RU = ("Цена приближается к нижней границе целевого сопротивления, о которой "
                    "мы писали в обзоре два дня назад. Фиксируем половину от оставшейся "
                    "позиции, а стоп-лосс для остатка переносим на отметку 84. График: "
                    "https://www.tradingview.com/x/NnIMs9eL/")

ETH337_OPENED_RU = ("Открываем среднесрочную шорт-позицию по ETH с уровнем риска на "
                    "максимумах сегодняшней сессии. Восстановление от июньских минимумов "
                    "формируется как диагональная структура, которая в большинстве случаев "
                    "завершается глубокой коррекцией.")

CL_EN_MESSAGE_IDS = (1128, 1161, 1227, 1267, 1268, 1346)
ETH_EN_MESSAGE_IDS = (1316, 1345)


def _cl331():
    return {
        "ticker": "CL", "direction": "long", "asset_class": "crypto",
        "opened_at": "2026-07-10T12:03:56.923Z",
        "closed_at": "2026-07-27T06:15:05.353Z",
        "exit_price": 84, "result_rr": 2.62,
        "comment_ru": CL331_OPENED_RU, "close_comment_ru": None,
        "sheet_row_id": "Crypto:47",
        "events": [
            {"event_type": "opened", "message_id_ru": 1098,
             "triggered_at": "2026-07-10T12:03:56.923Z",
             "payload": {"triggered_price": 72.77}},
            {"event_type": "target_1_hit", "message_id_ru": 1131,
             "triggered_at": "2026-07-14T11:10:05.194Z",
             "payload": {"triggered_price": 80.16}},
            {"event_type": "target_2_hit", "message_id_ru": 1199,
             "triggered_at": "2026-07-17T13:25:05.068Z",
             "payload": {"triggered_price": 81.03}},
            {"event_type": "partial_closed", "message_id_ru": 1239,
             "triggered_at": "2026-07-22T08:26:11.301Z",
             "payload": {"partial_close_id": 3313}},
            {"event_type": "stop_moved", "message_id_ru": 1240,
             "triggered_at": "2026-07-22T08:29:31.189Z",
             "payload": {"old_stop": 69.9, "new_stop": 84}},
            {"event_type": "stop_hit", "message_id_ru": 1322,
             "triggered_at": "2026-07-27T06:15:05.353Z",
             "payload": {"triggered_price": 84}},
        ],
        "partial_closes": [
            {"id": 3311, "closed_at": "2026-07-14T11:10:05.194Z",
             "pct_closed": 25, "exit_price": 80.16, "comment_ru": None},
            {"id": 3312, "closed_at": "2026-07-17T13:25:05.068Z",
             "pct_closed": 25, "exit_price": 81.03, "comment_ru": None},
            {"id": 3313, "closed_at": "2026-07-22T08:26:11.301Z",
             "pct_closed": 25, "exit_price": 87.22, "comment_ru": CL331_PARTIAL_RU},
            {"id": 3314, "closed_at": "2026-07-27T06:15:05.353Z",
             "pct_closed": 25, "exit_price": 84, "comment_ru": None},
        ],
    }


def _eth337():
    return {
        "ticker": "ETH", "direction": "short", "asset_class": "crypto",
        "opened_at": "2026-07-23T16:28:29.917Z",
        "closed_at": "2026-07-26T22:35:04.995Z",
        "exit_price": 1941, "result_rr": -1,
        "comment_ru": ETH337_OPENED_RU, "close_comment_ru": None,
        "sheet_row_id": "Crypto:49",
        "events": [
            {"event_type": "opened", "message_id_ru": 1291,
             "triggered_at": "2026-07-23T16:28:29.917Z",
             "payload": {"triggered_price": 1887.38}},
            {"event_type": "stop_hit", "message_id_ru": 1321,
             "triggered_at": "2026-07-26T22:35:04.995Z",
             "payload": {"triggered_price": 1941}},
        ],
        "partial_closes": [
            {"id": 3371, "closed_at": "2026-07-26T22:35:04.995Z",
             "pct_closed": 100, "exit_price": 1941, "comment_ru": None},
        ],
    }


def _pc(pos):
    return {pc["id"]: pc for pc in pos["partial_closes"]}


def test_cl331_full_published_timeline():
    """All six published RU events become linked steps with the correct
    t.me/c/<RU_CHANNEL>/<RU_TOPIC>/<id> links, in lifecycle order."""
    p = _cl331()
    assert B.is_eligible(p) is True
    html = B.build_card(p, _pc(p))
    assert html.count('class="step"') == 6
    assert html.count('class="steplink"') == 6
    for mid in (1098, 1131, 1199, 1239, 1240, 1322):
        assert ("https://t.me/c/3773738299/4/%d" % mid) in html
    assert "badge-long" in html
    assert "+2.62R" in html
    assert "Выход: 84" in html
    assert "10.07.2026 → 27.07.2026" in html


def test_eth337_full_published_timeline():
    """Two published RU events -> two linked steps; a -1R short renders the loss
    styling and the stop price as the exit."""
    p = _eth337()
    assert B.is_eligible(p) is True
    html = B.build_card(p, _pc(p))
    assert html.count('class="step"') == 2
    assert html.count('class="steplink"') == 2
    for mid in (1291, 1321):
        assert ("https://t.me/c/3773738299/4/%d" % mid) in html
    assert "badge-short" in html
    assert '<span class="loss">-1.00R</span>' in html
    assert "Выход: 1941" in html
    assert "23.07.2026 → 26.07.2026" in html


def test_cl331_eth337_verbatim_ru_no_en_leak():
    """Stored subscriber text is byte-for-byte; the EN channel and every EN
    message id must never appear."""
    for pos, en_ids in ((_cl331(), CL_EN_MESSAGE_IDS), (_eth337(), ETH_EN_MESSAGE_IDS)):
        html = B.build_card(pos, _pc(pos))
        assert "3869302680" not in html          # EN channel id never leaks
        for mid in en_ids:
            assert ("/%d" % mid) not in html     # EN message ids never linked
        assert "–" not in html                   # en-dash is never used in RU copy
    cl = B.build_card(_cl331(), _pc(_cl331()))
    assert CL331_OPENED_RU in cl
    assert CL331_PARTIAL_RU in cl
    assert ETH337_OPENED_RU in B.build_card(_eth337(), _pc(_eth337()))


def test_cl331_generated_fallbacks_for_unwritten_events():
    """Events with no stored comment get RU fallbacks from the payload."""
    html = B.build_card(_cl331(), _pc(_cl331()))
    assert "Цель 1 достигнута по 80.16." in html
    assert "Цель 2 достигнута по 81.03." in html
    assert "Стоп перенесён с 69.9 на 84." in html
    assert "Стоп сработал по 84." in html
    assert "Стоп сработал по 1941." in B.build_card(_eth337(), _pc(_eth337()))


def _crypto_sheet(cl_row, eth_row):
    """Crypto sheet placing CL on Crypto:47 and ETH on Crypto:49."""
    data = [[""] * 11 for _ in range(49)]
    data[2] = ["", "Ticker", "", "", ""] + [""] * 6
    data[46] = cl_row
    data[48] = eth_row
    return data


def _row(ticker, direction, status, entry, exit_, result, tv):
    return ["", ticker, direction, status, entry, exit_, "", "", "", result, tv]


CL_TV = "https://www.tradingview.com/x/bg3ygJ4E/"
ETH_TV = "https://www.tradingview.com/x/6s6GiXbP/"

CL_KEYS = ("CL|2026-07-10|2026-07-27", "cr#l#CL|2026-07-10|2026-07-27")
ETH_KEYS = ("ETH|2026-07-23|2026-07-26", "cr#s#ETH|2026-07-23|2026-07-26")


def test_cl331_eth337_prebuilt_only_after_close():
    """Closed-only policy preserved: neither trade is prebuilt while its sheet
    row is Open; once Closed with an exit and numeric result, both resolve under
    the full and collision-safe keys."""
    sb = {"positions": [_cl331(), _eth337()]}

    open_sheet = _crypto_sheet(
        _row("CL", "Long", "Open", "10.07.2026", "", "", CL_TV),
        _row("ETH", "Short", "Open", "23.07.2026", "", "", ETH_TV))
    man = {}
    B.build([], open_sheet, sb, man)
    assert man == {}, "open rows must not be prebuilt"

    closed_sheet = _crypto_sheet(
        _row("CL", "Long", "Closed", "10.07.2026", "27.07.2026", "2,62", CL_TV),
        _row("ETH", "Short", "Closed", "23.07.2026", "26.07.2026", "-1,00", ETH_TV))
    man = {}
    B.build([], closed_sheet, sb, man)
    for kf, ks in (CL_KEYS, ETH_KEYS):
        assert man.get(kf, {}).get("kind") == "bot"
        assert man.get(ks, {}).get("kind") == "bot"
        assert man[kf]["ru"] == man[ks]["ru"]
    assert man[CL_KEYS[0]]["ru"].count('class="step"') == 6
    assert man[ETH_KEYS[0]]["ru"].count('class="step"') == 2


def test_cl331_eth337_present_in_committed_manifest():
    """The production manifest carries both rebuilt timelines under the full,
    collision-safe and pair keys, byte-identical to a fresh build."""
    with open(A.MANIFEST) as f:
        m = json.load(f)
    expected = {"CL": B.build_card(_cl331(), _pc(_cl331())),
                "ETH": B.build_card(_eth337(), _pc(_eth337()))}
    for ticker, (kf, ks), kp in (("CL", CL_KEYS, "CL|2026-07-10"),
                                 ("ETH", ETH_KEYS, "ETH|2026-07-23")):
        for k in (kf, ks, kp):
            assert m.get(k, {}).get("kind") == "bot", "missing key %s" % k
            assert m[k]["ru"] == expected[ticker], "manifest drifted from build: %s" % k


def test_july_eth_short_does_not_borrow_an_older_eth_long():
    """Five older ETH longs are carded. The July short must resolve to its own
    card under every key form -- collision safety across direction and dates."""
    with open(A.MANIFEST) as f:
        m = json.load(f)
    july = m["cr#s#ETH|2026-07-23|2026-07-26"]["ru"]
    assert "badge-short" in july
    for older in ("ETH|2026-05-26|2026-05-26", "ETH|2026-05-09|2026-05-12",
                  "ETH|2026-04-29|2026-04-29", "ETH|2026-04-10|2026-04-12",
                  "ETH|2025-08-03|2025-08-14"):
        assert m[older]["ru"] != july
    # the pair alias for the July short is unique to it
    assert m["ETH|2026-07-23"]["ru"] == july


def test_degraded_fallback_carries_both_closed_trades():
    """If the live sheet CSV fetch fails, the offline crypto dataset must still
    render both trades with the TradingView links their snapshots derive from."""
    with open(os.path.join(REPO, "ru", "trades-fallback-crypto.json")) as f:
        rows = json.load(f)
    by_key = {(r[1], r[4]): r for r in rows[1:]}
    cl = by_key[("CL", "10.07.2026")]
    assert cl[3] == "Closed" and cl[5] == "27.07.2026" and cl[9] == "2,62"
    assert cl[10] == CL_TV
    eth = by_key[("ETH", "23.07.2026")]
    assert eth[2] == "Short" and eth[3] == "Closed" and eth[5] == "26.07.2026"
    assert eth[9] == "-1,00" and eth[10] == ETH_TV

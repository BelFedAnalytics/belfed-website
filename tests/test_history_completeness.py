import copy
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import ru_card_build as B
import refresh_review_cards as R
from test_refresh_review_cards import _sheets
from test_ru_audit import _cl331, CL_KEYS


def test_orphan_partial_keeps_numbers_comment_chart_without_a_fabricated_link():
    p = _cl331()
    p["partial_closes"].append({
        "id": 987, "closed_at": "2026-07-23T10:00:00Z", "pct_closed": 5,
        "exit_price": 88, "comment_ru": "Фиксируем часть прибыли.",
        "chart_url": "https://www.tradingview.com/x/Test123/",
    })
    html = B.build_card(p, {pc["id"]: pc for pc in p["partial_closes"]})
    assert html.count('class="step"') == 7
    assert html.count('class="steplink"') == 6
    assert "Закрыто 5% по 88." in html
    assert "Фиксируем часть прибыли." in html
    assert "snapshots/t/Test123.png" in html
    assert html.index("23.07.2026") < html.index("27.07.2026</span>")


def test_top_level_trigger_price_is_used_and_sanitized():
    from test_refresh_review_cards import _envelope, _validate
    env = _envelope()
    env["events"][0]["payload"] = {}
    env["events"][0]["triggered_price"] = 84
    p = _validate(env)[0]
    html = B.build_card(p, {pc["id"]: pc for pc in p["partial_closes"]})
    assert "Стоп сработал по 84." in html


def test_existing_generated_cards_refresh_but_manual_cards_do_not():
    p = _cl331()
    man = {k: {"kind": "bot", "ru": "stale"} for k in CL_KEYS}
    count, _ = R.refresh([p], _sheets(), man)
    assert count == 1
    assert "+2.62R" in man[CL_KEYS[0]]["ru"]
    snapshot = copy.deepcopy(man)
    assert R.refresh([p], _sheets(), man)[0] == 0
    assert snapshot == man
    manual = {k: {"kind": "manual", "ru": "curated", "manual": {"keep": 1}} for k in CL_KEYS}
    snapshot = copy.deepcopy(manual)
    assert R.refresh([p], _sheets(), manual)[0] == 0
    assert snapshot == manual


def test_target_record_and_event_make_one_step_with_size():
    p = _cl331()
    html = B.build_card(p, {pc["id"]: pc for pc in p["partial_closes"]})
    assert html.count('class="step"') == 6
    assert "Закрыто 25% по 87.22." in html


def test_ru_schedule_is_fifteen_minutes():
    from pathlib import Path
    workflow = Path(__file__).parents[1] / ".github/workflows/refresh-review-cards.yml"
    assert "11,26,41,56 * * * *" in workflow.read_text()


def test_structured_enrichment_on_bot_card_survives_refresh():
    manual = {"ru": {"title": "Проверенное описание"}}
    man = {CL_KEYS[0]: {"kind": "bot", "ru": "stale", "manual": manual}}
    R.refresh([_cl331()], _sheets(), man)
    assert man[CL_KEYS[0]]["manual"] == manual


def test_final_close_without_trigger_price_is_not_duplicated():
    p = _cl331()
    p["events"][-1]["event_type"] = "closed"
    p["events"][-1]["payload"] = {}
    html = B.build_card(p, {pc["id"]: pc for pc in p["partial_closes"]})
    assert html.count('class="step"') == 6
    assert "Закрыто по 84." in html


def test_public_card_matches_published_row_without_mutating_db_result():
    p = _cl331()
    p["result_rr"] = 3.6
    man = {}
    R.refresh([p], _sheets(), man)
    assert "+2.62R" in man[CL_KEYS[0]]["ru"]
    assert p["result_rr"] == 3.6

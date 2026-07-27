#!/usr/bin/env python3
"""Regression tests for the unattended post-close manifest refresh.

Everything here runs offline: the sheet CSV and the Supabase response are
supplied as fixtures, so the suite exercises the sanitizing boundary, the
row-matching rules and the idempotency guarantee without touching production.
"""
import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(REPO, "scripts"))

import refresh_review_cards as R    # noqa: E402

from test_ru_audit import _cl331, _eth337, CL_KEYS, ETH_KEYS   # noqa: E402


# ------------------------------------------------------------ date parsing --
@pytest.mark.parametrize("raw,iso", [
    ("10.07.2026", "2026-07-10"),
    ("1.5.2026", "2026-05-01"),
    ("2026-07-10", "2026-07-10"),
    ("", ""), ("garbage", ""), ("Entry Date", ""),
])
def test_to_iso(raw, iso):
    assert R._to_iso(raw) == iso


def test_row_number_requires_matching_tab():
    assert R._row_number("Crypto:47", "Crypto") == 47
    assert R._row_number("Equties:167", "Equties") == 167
    assert R._row_number("Crypto:47", "Equties") is None
    assert R._row_number("", "Crypto") is None
    assert R._row_number("Crypto:x", "Crypto") is None


# ------------------------------------------------------------ sheet index ---
CSV = (
    "#,Ticker,Direction,Status,Entry Date,Exit Date,Entry,Risk,Exit,Result,TVlink\n"
    ",CL,Long,Closed,10.07.2026,27.07.2026,\"72,77\",\"69,9\",84,\"2,62\",tv1\n"
    ",ETH,Short,Closed,23.07.2026,26.07.2026,\"1887,38\",1941,1941,\"-1,00\",tv2\n"
    ",XAU,Long,Open,01.07.2026,,4081,3957,,,tv3\n"
)


def test_index_sheet_keys_by_ticker_and_entry():
    idx = R.index_sheet(R.parse_rows(CSV))
    assert set(idx) == {("CL", "2026-07-10"), ("ETH", "2026-07-23"),
                        ("XAU", "2026-07-01")}
    assert idx[("CL", "2026-07-10")][5] == "27.07.2026"


def test_index_sheet_drops_ambiguous_duplicates():
    """Two rows sharing ticker+entry cannot be resolved to one trade, so
    neither is offered to the builder."""
    dup = CSV + ",CL,Long,Closed,10.07.2026,30.07.2026,72,69,90,\"3,00\",tv9\n"
    idx = R.index_sheet(R.parse_rows(dup))
    assert ("CL", "2026-07-10") not in idx
    assert ("ETH", "2026-07-23") in idx


def test_parse_rows_keeps_quoted_newline_in_one_row():
    text = ('#,Ticker,Direction,Status,Entry Date\n'
            ',CL,Long,Closed,10.07.2026\n'
            ',ETH,"Sh\north",Closed,23.07.2026\n')
    rows = R.parse_rows(text)
    assert len(rows) == 3
    assert rows[2][2] == "Sh\north"


# --------------------------------------------------------- sheet placement --
def test_build_sheet_arrays_places_row_at_sheet_row_id_index():
    """Row identity comes from sheet_row_id, not from CSV ordering."""
    idx = R.index_sheet(R.parse_rows(CSV))
    cr = R.build_sheet_arrays([_cl331(), _eth337()], idx, "Crypto")
    assert len(cr) == 49                    # Crypto:49 is the highest placed row
    assert cr[46][1] == "CL"                # Crypto:47 -> index 46
    assert cr[48][1] == "ETH"               # Crypto:49 -> index 48
    assert cr[47][1] == ""                  # untouched filler


def test_build_sheet_arrays_skips_unmatched_position():
    """A position with no live sheet row is skipped, never guessed at."""
    idx = R.index_sheet(R.parse_rows(CSV))
    orphan = _cl331()
    orphan["ticker"] = "NOPE"
    assert R.build_sheet_arrays([orphan], idx, "Crypto") == []


def test_build_sheet_arrays_ignores_other_tab():
    idx = R.index_sheet(R.parse_rows(CSV))
    assert R.build_sheet_arrays([_cl331(), _eth337()], idx, "Equties") == []


# --------------------------------------------------------------- sanitizer --
RAW_POSITION = {
    "id": 331, "ticker": "CL", "direction": "long", "asset_class": "crypto",
    "status": "closed", "opened_at": "2026-07-10T12:03:56.923Z",
    "closed_at": "2026-07-27T06:15:05.353Z", "exit_price": 84, "result_rr": 2.62,
    "comment_ru": "русский текст", "comment_en": "ENGLISH LEAK",
    "close_comment_ru": None, "close_comment_en": "ENGLISH CLOSE LEAK",
    "sheet_row_id": "Crypto:47",
    "internal_note": "SECRET OPS NOTE", "created_by": "ops@belfed.com",
    "partial_closes": [
        {"id": 3313, "pct_closed": 25, "exit_price": 87.22,
         "closed_at": "2026-07-22T08:26:11.301Z", "comment_ru": "частичное",
         "comment_en": "ENGLISH PARTIAL LEAK", "source": "manual"},
    ],
    "position_events": [
        {"event_type": "opened", "message_id_ru": 1098, "message_id_en": 1128,
         "triggered_at": "2026-07-10T12:03:56.923Z",
         "payload": {"triggered_price": 72.77, "comment_en": "ENGLISH PAYLOAD LEAK"}},
        {"event_type": "edited", "message_id_ru": None, "message_id_en": 1200,
         "triggered_at": "2026-07-11T00:00:00Z", "payload": {"comment_ru": "unpublished"}},
        {"event_type": "stop_hit", "message_id_ru": 1322, "message_id_en": 1346,
         "triggered_at": "2026-07-27T06:15:05.353Z", "payload": {"triggered_price": 84}},
    ],
}


def test_sanitize_keeps_only_whitelisted_position_fields():
    p = R.sanitize_position(RAW_POSITION)
    assert set(p) == set(R.POSITION_FIELDS) | {"events", "partial_closes"}
    blob = json.dumps(p, ensure_ascii=False)
    for leak in ("ENGLISH LEAK", "ENGLISH CLOSE LEAK", "ENGLISH PARTIAL LEAK",
                 "ENGLISH PAYLOAD LEAK", "SECRET OPS NOTE", "ops@belfed.com",
                 "message_id_en", "comment_en"):
        assert leak not in blob, "sanitizer leaked %r" % leak


def test_sanitize_drops_unpublished_events_and_sorts():
    p = R.sanitize_position(RAW_POSITION)
    assert [e["event_type"] for e in p["events"]] == ["opened", "stop_hit"]
    assert "unpublished" not in json.dumps(p, ensure_ascii=False)
    assert p["events"][0]["message_id_ru"] == 1098


def test_sanitize_projects_payload_and_partials():
    p = R.sanitize_position(RAW_POSITION)
    assert p["events"][0]["payload"] == {"triggered_price": 72.77}
    assert set(p["partial_closes"][0]) == set(R.PARTIAL_FIELDS)


def test_sanitized_position_builds_the_expected_card():
    """End to end through the sanitizer: the RU timeline still renders, with
    only the RU links."""
    import ru_card_build as B
    p = R.sanitize_position(RAW_POSITION)
    html = B.build_card(p, {pc["id"]: pc for pc in p["partial_closes"]})
    assert html.count('class="steplink"') == 2
    assert "https://t.me/c/3773738299/4/1098" in html
    assert "https://t.me/c/3773738299/4/1322" in html
    assert "3869302680" not in html


# --------------------------------------------------------------- refresh ----
def _sheets(csv_text=CSV):
    idx = R.index_sheet(R.parse_rows(csv_text))
    return {"crypto": idx, "equities": {}}


def test_refresh_writes_both_cards_then_is_idempotent():
    positions = [_cl331(), _eth337()]
    man = {}
    written, added = R.refresh(positions, _sheets(), man)
    assert written == 2
    for kf, ks in (CL_KEYS, ETH_KEYS):
        assert man[kf]["kind"] == "bot"
        assert man[ks]["ru"] == man[kf]["ru"]
    assert set(added) == set(CL_KEYS) | set(ETH_KEYS)

    snapshot = json.dumps(man, ensure_ascii=False, sort_keys=True)
    written2, added2 = R.refresh(positions, _sheets(), man)
    assert added2 == []
    assert json.dumps(man, ensure_ascii=False, sort_keys=True) == snapshot


def test_refresh_respects_closed_only_gate():
    """An Open sheet row yields no card even though the position is eligible."""
    open_csv = (
        "#,Ticker,Direction,Status,Entry Date,Exit Date,Entry,Risk,Exit,Result,TVlink\n"
        ",CL,Long,Open,10.07.2026,,\"72,77\",\"69,9\",,,tv1\n"
    )
    man = {}
    written, added = R.refresh([_cl331()], _sheets(open_csv), man)
    assert man == {} and added == [] and written == 0


def test_refresh_refuses_to_clobber_an_existing_entry():
    """Hand-tuned cards are immutable; a would-be overwrite aborts the run."""
    man = {CL_KEYS[1]: {"kind": "bot", "ru": "<article>hand tuned</article>"}}
    with pytest.raises(RuntimeError, match="clobber"):
        R.refresh([_cl331()], _sheets(), man)


def test_refresh_preserves_unrelated_entries():
    man = {"OTHER|2026-01-01|2026-01-02": {"kind": "legacy", "ru": "<p>x</p>"}}
    keep = dict(man)
    R.refresh([_cl331(), _eth337()], _sheets(), man)
    for k, v in keep.items():
        assert man[k] == v


# ------------------------------------------------------------ credentials ---
def test_missing_credentials_is_a_clean_no_op(monkeypatch, tmp_path, capsys):
    """No secrets configured must not fail the nightly run."""
    for var in ("SUPABASE_URL", "SUPABASE_CARD_EXPORT_KEY",
                "SUPABASE_SERVICE_ROLE_KEY"):
        monkeypatch.delenv(var, raising=False)
    out = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    assert R.main([]) == 0
    assert "changed=false" in out.read_text()
    assert "credentials absent" in capsys.readouterr().out


def test_supabase_config_prefers_readonly_key(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co/")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service")
    monkeypatch.setenv("SUPABASE_CARD_EXPORT_KEY", "readonly")
    url, key = R.supabase_config()
    assert url == "https://example.supabase.co"      # trailing slash trimmed
    assert key == "readonly"
    monkeypatch.delenv("SUPABASE_CARD_EXPORT_KEY")
    assert R.supabase_config()[1] == "service"


def test_http_get_refuses_plaintext():
    with pytest.raises(ValueError, match="HTTPS"):
        R._http_get("http://example.com", {})


def test_fetch_positions_sends_auth_and_sanitizes():
    seen = {}

    def fake_get(url, headers):
        seen["url"] = url
        seen["headers"] = headers
        return json.dumps([RAW_POSITION])

    positions = R.fetch_positions("https://example.supabase.co", "KEY",
                                  opener=fake_get)
    assert seen["headers"]["apikey"] == "KEY"
    assert seen["headers"]["Authorization"] == "Bearer KEY"
    assert "status=eq.closed" in seen["url"]
    assert seen["url"].startswith("https://example.supabase.co/rest/v1/")
    assert "comment_en" not in json.dumps(positions, ensure_ascii=False)

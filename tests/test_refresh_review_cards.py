#!/usr/bin/env python3
"""Regression tests for the unattended post-close manifest refresh.

Everything here runs offline: the sheet CSV and the RPC response are supplied as
fixtures, so the suite exercises the request contract, the validating boundary,
the row-matching rules and the idempotency guarantee without touching
production.
"""
import io
import json
import os
import sys
import urllib.error

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


# -------------------------------------------------------- envelope fixture --
# Shaped like the real export: three sibling arrays joined on position_id, with
# extra columns present to prove the local re-projection still drops them even
# though the RPC already whitelists server side.
def _envelope():
    return {
        "generated_at": "2026-07-27T07:00:00.000Z",
        "positions": [{
            "id": 331, "ticker": "CL", "direction": "long",
            "asset_class": "crypto", "status": "closed",
            "opened_at": "2026-07-10T12:03:56.923Z",
            "closed_at": "2026-07-27T06:15:05.353Z",
            "exit_price": 84, "result_rr": 2.62,
            "comment_ru": "русский текст", "comment_en": "ENGLISH LEAK",
            "close_comment_ru": None, "close_comment_en": "ENGLISH CLOSE LEAK",
            "sheet_row_id": "Crypto:47",
            "internal_note": "SECRET OPS NOTE", "created_by": "ops@belfed.com",
        }],
        "events": [
            {"position_id": 331, "event_type": "stop_hit",
             "message_id_ru": 1322, "message_id_en": 1346,
             "triggered_at": "2026-07-27T06:15:05.353Z",
             "payload": {"triggered_price": 84}},
            {"position_id": 331, "event_type": "opened",
             "message_id_ru": 1098, "message_id_en": 1128,
             "triggered_at": "2026-07-10T12:03:56.923Z",
             "payload": {"triggered_price": 72.77,
                         "comment_en": "ENGLISH PAYLOAD LEAK"}},
            {"position_id": 331, "event_type": "edited",
             "message_id_ru": None, "message_id_en": 1200,
             "triggered_at": "2026-07-11T00:00:00Z",
             "payload": {"comment_ru": "unpublished"}},
            {"position_id": 999, "event_type": "opened", "message_id_ru": 1,
             "triggered_at": "2026-01-01T00:00:00Z", "payload": {}},
        ],
        "partial_closes": [
            {"position_id": 331, "id": 3313, "pct_closed": 25,
             "exit_price": 87.22, "closed_at": "2026-07-22T08:26:11.301Z",
             "comment_ru": "частичное", "comment_en": "ENGLISH PARTIAL LEAK",
             "source": "manual"},
            {"position_id": 999, "id": 9991, "pct_closed": 100,
             "exit_price": 1, "closed_at": "2026-01-01T00:00:00Z",
             "comment_ru": None},
        ],
    }


def _validate(env):
    return R.validate_envelope(json.dumps(env, ensure_ascii=False))


# --------------------------------------------------------------- validation --
def test_validate_keeps_only_whitelisted_position_fields():
    p = _validate(_envelope())[0]
    assert set(p) == set(R.POSITION_FIELDS) | {"events", "partial_closes"}
    blob = json.dumps(p, ensure_ascii=False)
    for leak in ("ENGLISH LEAK", "ENGLISH CLOSE LEAK", "ENGLISH PARTIAL LEAK",
                 "ENGLISH PAYLOAD LEAK", "SECRET OPS NOTE", "ops@belfed.com",
                 "message_id_en", "comment_en", "position_id"):
        assert leak not in blob, "validation leaked %r" % leak


def test_validate_joins_children_on_position_id_and_sorts():
    """Siblings attach to their own position only, in lifecycle order."""
    p = _validate(_envelope())[0]
    assert [e["event_type"] for e in p["events"]] == ["opened", "stop_hit"]
    assert "unpublished" not in json.dumps(p, ensure_ascii=False)
    assert [pc["id"] for pc in p["partial_closes"]] == [3313]


def test_validate_projects_payload_and_partials():
    p = _validate(_envelope())[0]
    assert p["events"][0]["payload"] == {"triggered_price": 72.77}
    assert set(p["partial_closes"][0]) == set(R.PARTIAL_FIELDS)


def test_validate_accepts_single_row_postgrest_wrapper():
    """PostgREST may return the scalar result wrapped in a one-row set."""
    assert _validate([_envelope()])[0]["ticker"] == "CL"
    with pytest.raises(RuntimeError, match="rows"):
        _validate([_envelope(), _envelope()])


@pytest.mark.parametrize("mutate,match", [
    (lambda e: e.pop("generated_at"), "generated_at"),
    (lambda e: e.update(positions={}), "positions"),
    (lambda e: e.update(events=None), "events"),
    (lambda e: e.pop("partial_closes"), "partial_closes"),
    (lambda e: e["positions"].append("nope"), "non-object position"),
    (lambda e: e["positions"][0].pop("closed_at"), "closed_at"),
    (lambda e: e["positions"][0].update(ticker=""), "ticker"),
])
def test_validate_rejects_malformed_payload(mutate, match):
    """A structurally wrong payload must raise, not yield zero cards: a silent
    empty result is indistinguishable from a legitimate no-op."""
    env = _envelope()
    mutate(env)
    with pytest.raises(RuntimeError, match=match):
        _validate(env)


def test_validate_rejects_non_json():
    with pytest.raises(RuntimeError, match="non-JSON"):
        R.validate_envelope("<html>gateway error</html>")


def test_validated_position_builds_the_expected_card():
    """End to end through validation: the RU timeline renders with RU links
    only."""
    import ru_card_build as B
    p = _validate(_envelope())[0]
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
ALL_VARS = ("SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY",
            "SUPABASE_CARD_EXPORT_KEY")


@pytest.mark.parametrize("present", [(), ALL_VARS[:1], ALL_VARS[:2]])
def test_incomplete_configuration_is_a_clean_no_op(present, monkeypatch,
                                                   tmp_path, capsys):
    """Absent or partial configuration must not fail the nightly run, and must
    name what is missing without printing any value."""
    for var in ALL_VARS:
        monkeypatch.delenv(var, raising=False)
    for var in present:
        monkeypatch.setenv(var, "sentinel-value")
    out = tmp_path / "gh_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(out))
    assert R.main([]) == 0
    assert "changed=false" in out.read_text()
    printed = capsys.readouterr().out
    assert "configuration absent" in printed
    assert "sentinel-value" not in printed
    for var in ALL_VARS[len(present):]:
        assert var in printed


def test_supabase_config_reads_all_three_and_has_no_service_role(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co/")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "pub")
    monkeypatch.setenv("SUPABASE_CARD_EXPORT_KEY", "token")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service")
    url, pub, token = R.supabase_config()
    assert url == "https://example.supabase.co"      # trailing slash trimmed
    assert (pub, token) == ("pub", "token")
    src = open(os.path.join(REPO, "scripts", "refresh_review_cards.py"),
               encoding="utf-8").read()
    assert "SERVICE_ROLE" not in src, "service-role path must stay removed"


def test_http_refuses_plaintext():
    with pytest.raises(ValueError, match="HTTPS"):
        R._http_get("http://example.com", {})
    with pytest.raises(ValueError, match="HTTPS"):
        R._http_post_json("http://example.com", {}, {})


# ------------------------------------------------------------ rpc contract ---
def test_fetch_positions_posts_the_documented_rpc_contract():
    seen = {}

    def fake_post(url, headers, body):
        seen.update(url=url, headers=headers, body=body)
        return json.dumps(_envelope(), ensure_ascii=False)

    positions = R.fetch_positions("https://example.supabase.co", "PUB", "TOKEN",
                                  poster=fake_post)
    assert seen["url"] == ("https://example.supabase.co"
                           "/rest/v1/rpc/export_review_card_data")
    assert seen["headers"]["apikey"] == "PUB"
    assert seen["headers"]["Content-Type"] == "application/json"
    assert "Authorization" not in seen["headers"]
    assert seen["body"] == {"p_token": "TOKEN"}
    # the token travels in the body only, never in the URL or a header
    assert "TOKEN" not in seen["url"]
    assert "TOKEN" not in json.dumps(seen["headers"])
    assert len(positions) == 1
    assert "comment_en" not in json.dumps(positions, ensure_ascii=False)


def _http_error(code):
    return urllib.error.HTTPError("https://example.supabase.co", code, "no",
                                  {}, io.BytesIO(b'{"message":"SECRET DETAIL"}'))


@pytest.mark.parametrize("code", [401, 403])
def test_fetch_positions_fails_loudly_on_rejected_token(code):
    """A rejected token aborts the run; the response body is never echoed."""
    def fake_post(url, headers, body):
        raise _http_error(code)

    with pytest.raises(RuntimeError) as ei:
        R.fetch_positions("https://example.supabase.co", "PUB", "BAD",
                          poster=fake_post)
    msg = str(ei.value)
    assert "rejected the export token" in msg and str(code) in msg
    assert "SECRET DETAIL" not in msg and "BAD" not in msg


def test_fetch_positions_reports_other_http_failures():
    def fake_post(url, headers, body):
        raise _http_error(500)

    with pytest.raises(RuntimeError, match="HTTP 500"):
        R.fetch_positions("https://example.supabase.co", "PUB", "TOKEN",
                          poster=fake_post)

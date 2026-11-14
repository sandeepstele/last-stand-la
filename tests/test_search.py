"""find_buildings over a synthetic overnight ranking (real rankings are licensed-data-derived and stay gitignored)."""

import json

import pytest

from app import search, tools


def _row(pid, city, ptype, readiness, deal, kw, priority, status="screened"):
    return {"costar": {"property_id": pid, "property_type": ptype, "city": city, "gba_sqft": 100000, "stories": 1,
                       "year_built": 1990},
            "screen": {"property_id": pid, "status": status, "headline": f"{kw} kW", "system_kw": kw,
                       "annual_kwh": kw * 1400, "co2_t_per_year": kw * 0.46, "load_matched_kw": None,
                       "readiness": readiness, "readiness_reasons": [f"r-{pid}"], "deal_fit": deal,
                       "deal_reasons": [f"d-{pid}"], "priority": priority}}


ROWS = [
    _row("900001", "Houston", "Industrial", "ready", "strong", 1000, 90),
    _row("900002", "houston", "Office", "ready", "moderate", 500, 80),  # lowercase city, as in the real kit
    _row("900003", "Los Angeles", "Industrial", "inspect", "weak", 2000, 70),
    _row("900004", "Houston", "Office", "reroof_first", "unknown", 3000, 60),
    _row("900005", "Houston", "Industrial", "unknown", "unknown", 0, 0, status="check_link"),
]


@pytest.fixture
def ranking(tmp_path, monkeypatch):
    p = tmp_path / "ranking.json"
    p.write_text(json.dumps(ROWS))
    monkeypatch.setenv("RADAR_RANKING_PATH", str(p))
    monkeypatch.setattr(search.costar, "get", lambda pid: {"address": f"{pid} Test St, Houston, TX"})
    return p


def ids(out):
    return [r["property_id"] for r in out["results"]]


def test_city_is_case_insensitive_and_skips_unsized(ranking):
    out = search.find(city="Houston")
    assert out["status"] == "ok" and out["matched"] == 3 and out["screened"] == 4 and out["not_sized"] == 1
    assert ids(out) == ["900001", "900002", "900004"]  # priority order; the check_link row is never offered


def test_city_aliases(ranking):
    assert ids(search.find(city="LA")) == ["900003"]
    assert ids(search.find(city="Los Angeles, CA")) == ["900003"]
    assert search.find(city="Houston, TX")["matched"] == 3


def test_could_we_sign_now(ranking):
    out = search.find(city="houston", readiness="ready", deal_fit="workable")
    assert ids(out) == ["900001", "900002"]
    first = out["results"][0]
    assert first["address"] == "900001 Test St, Houston, TX"
    assert first["readiness_reasons"] == ["r-900001"] and first["deal_reasons"] == ["d-900001"]
    assert first["annual_mwh"] == 1400 and first["city"] == "Houston"


def test_type_alias_min_kw_and_sort(ranking):
    assert ids(search.find(property_type="warehouse")) == ["900001", "900003"]
    assert ids(search.find(min_kw=1500, sort="system_kw")) == ["900004", "900003"]
    assert ids(search.find(sort="co2", limit=1)) == ["900004"]
    assert ids(search.find(readiness="re-roof first")) == ["900004"]


def test_limit_is_capped(tmp_path, monkeypatch):
    many = [_row(str(910000 + i), "Houston", "Office", "inspect", "weak", 100 + i, i) for i in range(15)]
    p = tmp_path / "many.json"
    p.write_text(json.dumps(many))
    monkeypatch.setenv("RADAR_RANKING_PATH", str(p))
    monkeypatch.setattr(search.costar, "get", lambda pid: {"address": None})
    out = search.find(limit=50)
    assert out["matched"] == 15 and len(out["results"]) == search.MAX_LIMIT


def test_bad_filter_lists_allowed_values(ranking):
    out = search.find(readiness="soon")
    assert out["status"] == "bad_filter" and "ready" in out["allowed"]
    assert search.find(property_type="spaceport")["status"] == "bad_filter"
    assert search.find(sort="vibes")["status"] == "bad_filter"


def test_missing_ranking_says_so(tmp_path, monkeypatch):
    monkeypatch.setenv("RADAR_RANKING_PATH", str(tmp_path / "nope.json"))
    assert search.find(city="houston")["status"] == "no_ranking"


def test_address_lookup_failure_is_not_fatal(ranking, monkeypatch):
    def boom(pid):
        raise FileNotFoundError("no kit on this machine")

    monkeypatch.setattr(search.costar, "get", boom)
    assert search.find(city="houston")["results"][0]["address"] is None


def test_tool_wrapper(ranking):
    out = tools.find_buildings.invoke({"city": "houston", "readiness": "ready", "deal_fit": "workable"})
    assert ids(out) == ["900001", "900002"]

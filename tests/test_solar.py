"""Solar screening on synthetic inputs (real CoStar/Vexcel values are licensed and stay out of the repo)."""

from datetime import UTC, datetime

import pytest

from app import solar, vexcel

NOW = datetime(2026, 11, 14, tzinfo=UTC)


def _costar(**kw):
    base = {"property_id": "SYN-1", "property_type": "Industrial", "city": "Houston", "gba_sqft": 240_000, "stories": 1,
            "year_built": 1980, "roof_renovation_years": [], "owner_occupied": None, "tenancy_type": None, "leed_end_years": []}
    return {**base, **kw}


def _aerial(**kw):
    base = {"footprint_sqft": 250_000, "roof_shape": "flat", "roof_perimeter_ft": 2_000, "roof_max_dimension_ft": 600,
            "roof_condition_score": 4.3, "roof_defects_severe": [], "roof_objects": {"roof-vent": 20}, "existing_pv_sqft": 0,
            "roof_tree_cover_pct": 0.0, "roof_object_area_sqft": 0.0, "warnings": []}
    return {**base, **kw}


def test_flat_warehouse_is_sized_with_sourced_inputs():
    s = solar.screen(_costar(), _aerial(), now=NOW)
    assert s.status == "screened"
    # 250,000 - setback (2000*6 - 4*36 = 11,856) - vents (20*10) = 237,944 sq ft usable
    assert s.usable_roof_sqft == 237_944
    assert s.roof_breakdown["setback_ft"] == 6.0
    assert s.system_kw == pytest.approx(237_944 * 0.60 * 20 / 1000, rel=1e-3)
    assert s.inputs_status["yield"] == "sourced" and s.inputs_status["load"] == "sourced"
    assert s.annual_kwh == pytest.approx(s.system_kw * 1379.5, rel=1e-3)
    assert s.co2_t_per_year == pytest.approx(s.annual_kwh / 1000 * 733.862 * 0.000453592, rel=1e-2)


def test_equipment_and_shade_reduce_usable_roof():
    busy = solar.screen(_costar(property_type="Office", stories=2, gba_sqft=500_000),
                        _aerial(roof_objects={"ac-unit": 74, "roof-vent": 212, "skylight": 9}, roof_tree_cover_pct=10.0), now=NOW)
    clean = solar.screen(_costar(property_type="Office", stories=2, gba_sqft=500_000), _aerial(roof_objects={}), now=NOW)
    assert busy.roof_breakdown["equipment_keepout_sqft"] == 74 * 150 + 212 * 10 + 9 * 60
    assert busy.usable_roof_sqft < clean.usable_roof_sqft * 0.9


def test_footprint_that_cannot_be_the_building_is_not_sized():
    """Real case: a 2,065 sq ft shed came back for a 1.23M sq ft warehouse."""
    s = solar.screen(_costar(gba_sqft=1_230_000), _aerial(footprint_sqft=2_065), now=NOW)
    assert s.status == "check_link" and s.system_kw == 0


@pytest.mark.parametrize("score,severe,expected", [(2.9, [], "reroof_first"), (4.5, ["tarp"], "reroof_first"),
                                                    (3.5, [], "inspect"), (4.5, [], "inspect")])
def test_roof_readiness(score, severe, expected):
    # 1980 roof with no renovation on record is 46 years old -> at best "inspect"
    s = solar.screen(_costar(), _aerial(roof_condition_score=score, roof_defects_severe=severe), now=NOW)
    assert s.readiness == expected


def test_new_roof_in_good_condition_is_ready():
    s = solar.screen(_costar(year_built=2019), _aerial(roof_condition_score=4.6), now=NOW)
    assert s.readiness == "ready"


def test_deal_fit_uses_ownership_tenancy_and_leases():
    strong = solar.screen(_costar(owner_occupied=True), _aerial(), {"share_leased_beyond_horizon": 0.8, "horizon_years": 10}, now=NOW)
    weak = solar.screen(_costar(tenancy_type="MultiTenant"), _aerial(), {"share_leased_beyond_horizon": 0.05, "horizon_years": 10}, now=NOW)
    assert strong.deal_fit == "strong" and weak.deal_fit == "weak"
    assert strong.priority > weak.priority


def test_los_angeles_yield_is_labeled_until_refreshed():
    s = solar.screen(_costar(city="Los Angeles"), _aerial(), now=NOW)
    assert s.inputs_status["yield"] in ("sourced", "placeholder")
    if s.inputs_status["yield"] == "placeholder":
        assert any("placeholder" in w for w in s.warnings)


def test_multifamily_load_is_not_modeled():
    s = solar.screen(_costar(property_type="Multifamily"), _aerial(), now=NOW)
    assert s.building_load_kwh is None and s.inputs_status["load"] == "not modeled"


# ------------------------------------------------------------- Vexcel normalization (synthetic response)


def _square(lon, lat, half_deg):
    return f"POLYGON(({lon-half_deg} {lat-half_deg}, {lon+half_deg} {lat-half_deg}, {lon+half_deg} {lat+half_deg}, {lon-half_deg} {lat+half_deg}, {lon-half_deg} {lat-half_deg}))"


def _feature(date, footprint, wkt, height_ft=30.0):
    return {"geometry": {"type": "Polygon", "coordinates": [[[-95.41, 29.75], [-95.40, 29.75], [-95.40, 29.76], [-95.41, 29.76], [-95.41, 29.75]]]},
            "properties": {"metadata.collection": f"us-tx-houston-{date[:4]}", "metadata.ortho-date-estimate": date, "structure.count": 2,
                           "structures": [
                               {"footprint.area": 2_000, "footprint.wkt": _square(-95.409, 29.759, 0.0001), "roof-characteristics.shape.value": "gable"},
                               {"footprint.area": footprint, "footprint.wkt": wkt, "roof-characteristics.height": height_ft,
                                "roof-characteristics.shape.value": "flat", "roof-characteristics.condition.precise-value": 2.93,
                                "roof-objects.roof-vent.count": 20, "roof-defects.tarp.detected": False}]}}


def test_normalize_picks_newest_capture_and_the_structure_at_the_point():
    big = _square(-95.405, 29.755, 0.002)
    raw = {"features": [_feature("2025-01-06", 249_000, big), _feature("2026-01-03", 250_985, big), _feature("2021-02-07", 240_000, big)]}
    rec = vexcel.normalize(raw, "SYN-1", lat=29.755, lon=-95.405)
    assert rec["capture_date"] == "2026-01-03" and rec["footprint_sqft"] == 250_985
    assert rec["structure_chosen_by"] == "contains the CoStar point"
    assert rec["height_m"] == pytest.approx(30 * 0.3048, abs=0.01)
    assert rec["roof_condition_score"] == 2.93 and rec["roof_objects"] == {"roof-vent": 20}
    assert [h["date"] for h in rec["footprint_history"]] == ["2021-02-07", "2025-01-06", "2026-01-03"]
    assert rec["roof_perimeter_ft"] > 0 and rec["roof_max_dimension_ft"] > 250


def test_property_extract_retries_on_429(monkeypatch):
    import httpx

    monkeypatch.setenv("VEXCEL_API_KEY", "test-key")
    calls, waits = [], []

    def handler(request):
        calls.append(request)
        assert request.headers["X-API-KEY"] == "test-key"
        assert request.url.params["wkt"] == "POINT(-95.4 29.7)"  # longitude first
        if len(calls) < 3:
            return httpx.Response(429)
        return httpx.Response(200, json={"features": []})

    out = vexcel.property_extract(29.7, -95.4, transport=httpx.MockTransport(handler), sleep=waits.append)
    assert out == {"features": []} and len(calls) == 3 and len(waits) == 2


def test_oversized_roof_reports_a_load_matched_array():
    s = solar.screen(_costar(gba_sqft=100_000), _aerial(footprint_sqft=250_000), now=NOW)
    assert s.load_offset_pct > 100
    assert s.load_matched_kw == pytest.approx(100_000 * 5.8 / 1379.5, rel=1e-2)
    assert "covers the building" in s.headline

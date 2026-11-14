import json
from pathlib import Path

import pytest

from app import interior, matterport
from app.verify import Aerial, Records, investigate, normalize_city, reconcile_area, retrofit_math

DEMO_PATH = Path(__file__).resolve().parent.parent / "fixtures/matterport/Phin78u7wQN.json"


def _layout(levels_z: dict[str, float], origin_floor: str, span_m: float = 34.0) -> dict:
    """Synthetic twin: a grid of scans per level over span_m x span_m (34 m ≈ 12,400 sq ft padded),
    plus one scan at the origin on `origin_floor`."""
    floors = [{"id": f, "sequence": i, "label": f} for i, f in enumerate(levels_z)]
    locs = [{"id": "origin", "position": {"x": 0, "y": 0, "z": levels_z[origin_floor]}, "floor": {"id": origin_floor}}]
    step = span_m / 4
    for f, z in levels_z.items():
        locs += [
            {"id": f"{f}{i}{j}", "position": {"x": 1 + i * step, "y": 1 + j * step, "z": z + 0.01 * i}, "floor": {"id": f}}
            for i in range(5) for j in range(5)
        ]
    return {"id": "synthetic", "floors": floors, "locations": locs}


STORY = (Records(rba_sqft=48_000, stories=3), Aerial(footprint_sqft=13_700))


# ------------------------------------------------------------- interior


@pytest.mark.skipif(not DEMO_PATH.exists(), reason="Matterport demo fixture is local-only (not in the public repo)")
def test_demo_model_profile_reanchors_the_entrance():
    p = interior.profile(json.loads(DEMO_PATH.read_text()))
    assert p.scanned_levels == 3 and p.unplaced_scans == 19
    # The first scan was on "Floor 2", but "Floor 1" is ground-labeled: it becomes the entrance.
    assert p.entrance_ambiguous and p.levels_below_entrance == []
    assert p.full_levels_from_entrance == 3
    assert 3.2 < p.typical_floor_to_floor_m < 3.7


def test_mezzanine_counts_levels_not_pairs():
    p = interior.profile(_layout({"L1": 0.0, "M": 2.0, "L2": 4.0}, origin_floor="L1"))
    assert p.mezzanine_levels == ["M"]
    assert p.full_levels_from_entrance == 2
    assert p.typical_floor_to_floor_m == 4.0


def test_coverage_reflects_scanned_extent():
    whole = interior.profile(_layout({"L1": 0.0}, "L1"))
    suite = interior.profile(_layout({"L1": 0.0}, "L1", span_m=6.0))
    assert whole.coverage(13_700) > 0.7
    assert suite.coverage(13_700) < 0.2


# ------------------------------------------------------------- reconciliation and verdicts


@pytest.mark.parametrize("listed,status", [(30_000, "within"), (45_000, "above"), (20_000, "below")])
def test_reconcile_status(listed, status):
    r = reconcile_area(listed, footprint_sqft=10_000, stories=3)  # 24,000-30,000 expected
    assert r.status == status
    assert (r.gap_pct == 0) == (status == "within")


def test_consistent_record():
    inv = investigate(Records(rba_sqft=40_000, stories=3), Aerial(footprint_sqft=14_000))
    assert inv.verdict == "consistent" and inv.trusted_area_sqft == 40_000


def test_story_a_basement_found_inside():
    twin = interior.profile(_layout({"B1": -4.0, "L1": 0.0, "L2": 4.0, "L3": 8.0}, origin_floor="L1"))
    inv = investigate(*STORY, twin)
    assert inv.initial.status == "above" and inv.applied == ["below_grade"]
    assert inv.verdict == "verified_inside_and_out" and inv.confidence == "high"


def test_basement_area_is_capped_at_its_scanned_extent():
    """A one-room basement can't add a whole footprint."""
    twin = interior.profile(_layout({"B1": -4.0, "L1": 0.0, "L2": 4.0, "L3": 8.0}, origin_floor="L1"))
    twin.levels[0].extent_m2 = 100.0  # basement scanned over ~1,076 sq ft only
    inv = investigate(*STORY, twin)
    bg = next(h for h in inv.hypotheses if h.key == "below_grade")
    assert bg.extra_gross_sqft < 1_200
    assert inv.verdict != "verified_inside_and_out"


def test_story_b_full_twin_rules_out_inside_explanations():
    twin = interior.profile(_layout({"L1": 0.0, "L2": 4.0, "L3": 8.0}, origin_floor="L1"))
    inv = investigate(Records(rba_sqft=48_000, stories=3, building_count=1), Aerial(footprint_sqft=13_700, height_m=12.0), twin)
    assert inv.verdict == "worth_a_look"
    statuses = {h.key: h.status for h in inv.hypotheses}
    assert statuses["below_grade"] == statuses["mezzanine"] == statuses["floor_count"] == "ruled_out"


def test_partial_twin_cannot_rule_out_a_basement():
    """Regression: a one-suite twin used to 'rule out' basement and mezzanine."""
    suite = interior.profile(_layout({"L1": 0.0}, "L1", span_m=6.0))
    inv = investigate(Records(rba_sqft=20_000, stories=1), Aerial(footprint_sqft=13_700), suite)
    statuses = {h.key: h.status for h in inv.hypotheses}
    assert statuses["below_grade"] == statuses["mezzanine"] == "untested"


def test_one_mezzanine_is_not_counted_twice():
    """Regression: L1/M/L2 used to add 13,700 sq ft as two mezzanine pairs plus an extra floor."""
    twin = interior.profile(_layout({"L1": 0.0, "M": 2.0, "L2": 4.0}, origin_floor="L1"))
    inv = investigate(Records(rba_sqft=45_000, stories=2), Aerial(footprint_sqft=13_700, height_m=8.5), twin)
    mezz = next(h for h in inv.hypotheses if h.key == "mezzanine")
    fc = next(h for h in inv.hypotheses if h.key == "floor_count")
    assert mezz.extra_gross_sqft == 6_850
    assert fc.status == "ruled_out"
    assert inv.verdict != "verified_inside_and_out"


def test_tall_roof_does_not_invent_a_floor():
    """Regression: 9.5 m / 3.31 m used to round to 3 floors and 'verify' a 2-story record."""
    twin = interior.profile(_layout({"L1": 0.0, "L2": 3.31}, origin_floor="L1"))
    inv = investigate(Records(rba_sqft=38_000, stories=2), Aerial(footprint_sqft=13_700, height_m=9.5), twin)
    fc = next(h for h in inv.hypotheses if h.key == "floor_count")
    assert fc.status == "ruled_out"
    assert inv.verdict == "worth_a_look"


def test_no_twin_is_low_confidence_not_a_false_alarm():
    inv = investigate(*STORY)
    assert inv.verdict == "worth_a_look" and inv.confidence == "low" and inv.trusted_area_sqft is None


def test_below_band_with_merged_footprint_is_likely_explained():
    inv = investigate(Records(rba_sqft=20_000, stories=3, building_count=2), Aerial(footprint_sqft=13_700))
    assert inv.initial.status == "below" and inv.verdict == "likely_explained"


def test_default_floor_height_alone_never_closes_a_gap():
    inv = investigate(Records(rba_sqft=48_000, stories=3), Aerial(footprint_sqft=13_700, height_m=20.0))
    fc = next(h for h in inv.hypotheses if h.key == "floor_count")
    assert fc.status == "supported" and fc.strength == "low"
    assert "floor_count" not in inv.applied


def test_merged_footprint_does_not_claim_an_unknown_land_area():
    inv = investigate(Records(rba_sqft=48_000, stories=3, building_count=1), Aerial(footprint_sqft=13_700))
    mf = next(h for h in inv.hypotheses if h.key == "merged_footprint")
    assert "land area unknown" in mf.evidence


def test_assumptions_are_labeled():
    inv = investigate(*STORY)
    assert inv.assumptions["mezzanine_share"]["status"] == "placeholder"
    assert inv.assumptions["efficiency_band"]["status"] == "heuristic"


# ------------------------------------------------------------- retrofit


def test_retrofit_sanity_and_placeholders():
    rec, aer = Records(rba_sqft=40_000, stories=3), Aerial(footprint_sqft=14_000, roof_object_area_sqft=1_500, roof_condition="poor")
    fix = retrofit_math(rec, aer, trusted_area_sqft=40_000, city="Los Angeles, CA")
    assert 0 < fix.usable_roof_sqft < 14_000 - 1_500
    assert fix.panels > 0 and 0 < fix.load_offset_pct < 100
    assert fix.reroof_first and fix.sequence.startswith("Re-roof")
    assert "yield_kwh_per_kw" in fix.placeholders


@pytest.mark.parametrize("city,key", [("Houston", "houston"), ("Houston, TX", "houston"), ("LA", "los_angeles")])
def test_city_names_are_normalized(city, key):
    assert normalize_city(city) == key


def test_unknown_city_is_a_clear_error():
    with pytest.raises(ValueError, match="unsupported city"):
        normalize_city("Austin")


# ------------------------------------------------------------- client safety


def test_client_rejects_injection():
    with pytest.raises(matterport.MatterportError):
        matterport.fetch_layout('x") { mutation')


def test_client_sends_only_read_queries():
    for q in (matterport._MODELS_QUERY, matterport._LAYOUT_QUERY):
        assert q.lstrip().startswith("{") and "mutation" not in q.lower()


def test_a_twin_taller_than_the_building_is_ignored():
    """Cross-layer check: three ~3.5 m levels can't fit in a 7.5 m building, so the twin is not this building."""
    twin = interior.profile(_layout({"L1": 0.0, "L2": 3.5, "L3": 7.0}, origin_floor="L1"))
    inv = investigate(Records(rba_sqft=38_000, stories=2), Aerial(footprint_sqft=13_700, height_m=7.5), twin)
    assert inv.warnings and "may not be this building" in inv.warnings[0]
    assert inv.twin_coverage is None
    assert inv.verdict == "worth_a_look"

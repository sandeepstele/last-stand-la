"""Cases, checks and weighing (app/evidence.py) on synthetic records: no kit, no network."""

import pytest

from app import evidence as ev

REC = {"property_id": "X1", "address": "1 Test St, Los Angeles, CA", "construction_material": "Steel", "year_built": 1970,
       "stories": 15, "zip": "90001", "street_addresses": ["1 Test St"]}


def assessed(*keys, steps_done=None):
    done = steps_done or {}
    steps = [{"step": s, "what": f"what {s}", "due": "2020-01-01", "done": done.get(s), "state": "done" if done.get(s) else "overdue"}
             for s in ("step_1", "step_2", "step_3")]
    return {"hypotheses": [{"key": k} for k in keys], "permits": [],
            "lists": [{"list": "non_ductile_concrete", "order_date": "2017-11-20", "steps": steps}]}


@pytest.fixture
def conflict(monkeypatch):
    monkeypatch.setattr(ev, "_ctx", lambda pid: (REC, assessed("unfinished", "material_conflict", steps_done={"step_1": "2019-12-02", "step_2": "2025-12-12"})))


def test_open_case_lists_hypotheses_and_checks(conflict):
    out = ev.open_case("X1")
    (case,) = out["cases"]
    assert case["case"] == "material_conflict"
    assert abs(sum(h["prior"] for h in case["hypotheses"]) - 1) < 1e-9
    assert {c["check"] for c in case["checks"]} == set(ev.CASES["material_conflict"]["checks"])


def test_no_case_when_records_agree(monkeypatch):
    monkeypatch.setattr(ev, "_ctx", lambda pid: (REC, assessed("unfinished")))
    assert ev.open_case("X1")["cases"] == []


def test_filed_plans_move_the_case_toward_the_city_list(conflict):
    r = ev.run_check("X1", "compliance_filings", "material_conflict")
    assert {e["hypothesis"]: e["delta"] for e in r["effects"]} == {"city_list_current": 0.35, "costar_current": -0.25}
    w = ev.weigh_case("X1", "material_conflict", ["compliance_filings"])
    assert w["verdict"]["hypothesis"] == "city_list_current" and w["verdict"]["label"] == "likely"
    assert abs(sum(w["posterior"].values()) - 1) < 0.02
    assert w["correction_draft"].startswith("DRAFT") and w["draft_needs_approval"]


def test_weak_evidence_stays_unresolved_without_a_draft(monkeypatch, conflict):
    monkeypatch.setitem(ev.CHECKS, "permit_text", lambda pid, case: {"finding": "none", "effects": [], "why": "nothing"})
    w = ev.weigh_case("X1", "material_conflict", ["permit_text"])
    assert w["verdict"]["label"] == "unresolved" and w["correction_draft"] is None
    assert w["next_check"] in ev.CASES["material_conflict"]["checks"]


def test_unknown_checks_and_cases_are_refused(conflict):
    assert ev.run_check("X1", "astrology", "material_conflict")["status"] == "bad_check"
    assert ev.run_check("X1", "permit_text", "vibes")["status"] == "bad_case"
    w = ev.weigh_case("X1", "material_conflict", ["astrology", "compliance_filings", "compliance_filings"])
    assert w["checks_used"] == ["compliance_filings"]  # unknown dropped, duplicates counted once


def test_implausible_floor_height_is_not_material_evidence(monkeypatch):
    from app import layers

    monkeypatch.setattr(ev, "_ctx", lambda pid: (REC, assessed("material_conflict")))
    monkeypatch.setattr(layers, "get_aerial", lambda pid: {"height_m": 20.0})  # 1.33 m per floor for 15 stories
    r = ev.run_check("X1", "era_and_height", "material_conflict")
    assert [e["hypothesis"] for e in r["effects"]] == ["different_structure"]


def test_vision_shifts_are_capped_and_unconfirmed_reads_count_for_nothing():
    confirmed = {"answer": "exposed_concrete_frame", "first_answer": "exposed_concrete_frame", "observed": "fins",
                 "second_look": "yes", "images": ["a.jpg"]}
    r = ev._vision_result(confirmed, [{"hypothesis": "city_list_current", "delta": 0.9}], "why", "Concrete frame visible")
    assert r["effects"] == [{"hypothesis": "city_list_current", "delta": ev.VISION_CAP}] and r["images"] == ["a.jpg"]
    doubted = dict(confirmed, answer="cant_tell", second_look="too dark to tell")
    r = ev._vision_result(doubted, [{"hypothesis": "city_list_current", "delta": 0.2}], "why", "x")
    assert r["effects"] == [] and "too dark" in r["finding"] and r["callout"] == "Can't tell from the images"


# ---------------------------------------------------------------- ghost tenants (synthetic facts)

FACTS = {"property_id": "X1", "suite": "300", "city": "Los Angeles",
         "tenants": [{"tenant": "a 50-person office", "employees": 50, "tenant_since": "2019-01-04", "lease_expires": "2024-08-19",
                      "business_status": "active", "sqft": 14000}],
         "listings": [{"type": "relet", "on_market": "2025-08-06", "available": "", "sqft": 14000, "lease_pending": False}],
         "listed_since": "2025-08-06", "tour": None, "trail_elsewhere": [{"since": "2025-11-26", "city": "Houston", "same_building": False, "suite": None}],
         "trail_same_building": []}


@pytest.fixture
def ghost(monkeypatch):
    from app import costar

    monkeypatch.setattr(ev, "_facts", lambda pid, suite: FACTS)
    monkeypatch.setattr(costar, "get", lambda pid: {"address": "1 Test St, Los Angeles, CA"})


def test_ghost_case_opens_per_suite_and_never_names_the_company(ghost):
    out = ev.open_case("X1", "300")
    assert out["cases"][0]["case"] == "ghost_tenant" and out["tenant"] == "a 50-person office"
    assert len(out["cases"][0]["hypotheses"]) == 5


def test_ghost_checks_move_toward_gone_and_draft_a_reverification(ghost):
    w = ev.weigh_case("X1", "ghost_tenant", ["listing_timeline", "lease_terms", "tenancy_trail"], "300")
    assert w["verdict"]["hypothesis"] == "gone_dark" and w["verdict"]["label"] in ("leaning", "likely")
    assert w["correction_draft"].startswith("DRAFT") and "re-verify occupancy" in w["correction_draft"]
    assert "a 50-person office" in w["correction_draft"]


def test_ghost_checks_need_the_suite(ghost):
    assert ev.run_check("X1", "tenancy_trail", "ghost_tenant")["finding"] == "this check needs the suite"


def test_tenant_described_by_industry_and_headcount():
    from app import tenants

    assert tenants.describe({"employees": 8, "industry": 1}) == "an 8-person accounting office"
    assert tenants.describe({"employees": 21, "industry": 0}) == "a 21-person office"
    assert tenants.describe({"employees": None, "industry": 4}) == "a real estate firm"

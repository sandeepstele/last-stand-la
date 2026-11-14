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
    assert "check_hints" not in case  # hints belong to the game wrapper, not the auditor
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


def test_check_stats_uses_every_queue_case_and_only_cached_contexts(monkeypatch):
    from app import cases, layers, vision

    ev.check_stats.cache_clear()
    rows = [{"case": "material_conflict", "property_id": "X1"},
            {"case": "ghost_tenant", "property_id": "X2", "suite": "101"}]
    monkeypatch.setattr(cases, "ordered", lambda: rows)
    calls = []

    def run(pid, check, case, suite=None, notes=None):
        calls.append((pid, check, case, suite))
        assert layers._CACHED_ONLY.get() and vision._CACHE_ONLY.get()
        effects = [{"hypothesis": "city_list_current", "delta": 0.3}] if check == "compliance_filings" else []
        return {"effects": effects}

    monkeypatch.setattr(ev, "run_check", run)
    stats = ev.check_stats()
    assert len(calls) == len(ev.CASES["material_conflict"]["checks"]) + len(ev.CASES["ghost_tenant"]["checks"])
    assert stats["material_conflict"]["compliance_filings"] == {
        "cases": 1, "moved_cases": 1, "move_rate": 1.0, "typical_move": 0.3, "expected_move": 0.3, "errors": 0}
    ev.check_stats.cache_clear()


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


def test_human_report_moves_the_case_and_is_capped(ghost):
    base = ev.weigh_case("X1", "ghost_tenant", ["listing_timeline", "tenancy_trail"], "300")
    note = {"note": "tenant is still there", "at": "2026-11-14", "source": "property manager (by phone)",
            "supports": "still_there", "recorded_by": "Radar, from a text"}
    one = ev.weigh_case("X1", "ghost_tenant", ["listing_timeline", "tenancy_trail", "human_report"], "300", notes=[note])
    assert one["posterior"]["still_there"] > base["posterior"]["still_there"]
    assert one["report_conflicts_with_records"] and one["next_check"].startswith("a fresh tour or a site visit")
    many = ev.run_check("X1", "human_report", "ghost_tenant", "300", notes=[note] * 5)
    assert many["effects"] == [{"hypothesis": "still_there", "delta": ev.HUMAN_CAP}]


def test_a_note_without_a_usable_hypothesis_moves_nothing(ghost):
    r = ev.run_check("X1", "human_report", "ghost_tenant", "300", notes=[{"note": "call me", "at": "2026-11-14", "supports": "vibes"}])
    assert r["effects"] == [] and "call me" in r["finding"]


def test_ghost_queue_has_one_case_per_suite(monkeypatch):
    from app import costar, tenants

    rows = [{"property_id": "1", "suite": "600", "city": "Los Angeles", "listed_since": "2025-01-01", "tour": None,
             "tenant": f"a {n}-person office", "employees": n, "tenant_since": "2019-01-01", "lease_expires": None,
             "business_status": "active", "sqft": 1000, "sublet": False, "tenant_after_listing": False, "moved_elsewhere": False}
            for n in (5, 9, 12)]
    rows.append(dict(rows[0], suite="700"))
    rows.append(dict(rows[0], suite="800", sublet=True))
    monkeypatch.setattr(tenants, "candidates", lambda: rows)
    monkeypatch.setattr(costar, "get", lambda pid: {"address": "1 Test St"})
    q = tenants.queue_rows()
    keys = [(r["property_id"], r["suite"]) for r in q]
    assert len(keys) == len(set(keys)) == 2  # 600 once (3 tenancies), 700 once, the sublet suite excluded
    six = next(r for r in q if r["suite"] == "600")
    assert six["label"] == "suite 600: 3 tenants on record (26 employees)" and six["id"] == "ghost_tenant:1#600"

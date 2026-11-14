"""LA retrofit-list matching and the four hypotheses, on synthetic list rows (no network, no kit)."""

import json

import pytest

from app import retrofit_lists as rl

TODAY = "2026-11-14"


@pytest.fixture
def public(tmp_path, monkeypatch):
    ss = [{"address": "100 N MAIN ST", "zip": "90012", "otc_date": "2016-01-01T00:00:00.000",
           "step_1_compl_date": "2017-01-01T00:00:00.000", "step_2_compl_date": "2019-01-01T00:00:00.000",
           "step_3_compl_date": "2023-01-01T00:00:00.000", "submitted": "2017-06-01T00:00:00.000"}]
    ndc = [{"address": "200 W 1ST STREET", "zip": "90012", "otc_date": "2017-11-20T00:00:00.000",
            "step_1_due_date": "2020-11-20T00:00:00.000", "step_2_due_date": "2027-11-20T00:00:00.000",
            "step_3_due_date": "2042-11-20T00:00:00.000", "checklist": "2019-12-02T00:00:00.000"},
           {"address": "400 HOPE ST", "zip": "90071", "otc_date": "2017-11-20T00:00:00.000",
            "step_1_due_date": "2020-11-20T00:00:00.000", "step_1_toll_order_ext_date": "2027-01-01T00:00:00.000"},
           {"address": "500 HOPE ST", "zip": "90071", "otc_date": "2017-11-20T00:00:00.000",
            "step_1_due_date": "2020-11-20T00:00:00.000", "step_1_toll_order_ext_date": "2023-10-20T00:00:00.000"},
           {"address": "300-310 Spring St", "zip": "90013", "otc_date": "2017-11-20T00:00:00.000",
            "step_1_due_date": "2020-11-20T00:00:00.000"}]
    permits = [{"primary_address": "100 MAIN ST", "zip_code": "90012", "issue_date": "2024-03-01T00:00:00.000",
                "permit_type": "Bldg-Alter/Repair", "status_desc": "Issued", "work_desc": "SOFT STORY RETROFIT PER ORD 183893"}]
    for name, rows in (("softstory", ss), ("ndc", ndc), ("retrofit_permits", permits)):
        (tmp_path / f"{name}.json").write_text(json.dumps(rows))
    monkeypatch.setattr(rl, "PUBLIC", tmp_path)
    rl._lists.cache_clear()
    yield
    rl._lists.cache_clear()


def rec(pid, addr, zip_, year, material="Unknown", city="Los Angeles", units=None):
    return {"property_id": pid, "city": city, "address": addr, "street_addresses": [addr], "zip": zip_,
            "year_built": year, "stories": 4, "units": units, "construction_material": material}


def keys(a):
    return [h["key"] for h in a["hypotheses"]]


def test_address_normalizer():
    assert rl.key_addr("300-310 Spring St, Los Angeles") == "300 SPRING ST"
    assert rl.key_addr("200 W 1st Street") == rl.key_addr("200 1ST ST") == "200 1ST ST"
    assert rl.key_addr("PO Box 7") is None


def test_unfinished_soft_story_past_due_with_recent_permit(public):
    a = rl.assess(rec("1", "100 Main St", "90012", 1962, "WoodFrame", units=24), today=TODAY)
    assert a["status"] == "unfinished" and a["lists"][0]["list"] == "soft_story"
    assert keys(a) == ["unfinished", "work_underway"]
    assert a["hypotheses"][0]["past_due"] is True
    assert a["lists"][0]["overdue_steps"] == ["step_2", "step_3"]  # plans were submitted, nothing after


def test_concrete_conflict_is_a_flag_not_an_accusation(public):
    a = rl.assess(rec("2", "200 1st St", "90012", 1970, "Steel"), today=TODAY)
    assert keys(a) == ["unfinished", "material_conflict"]
    assert a["hypotheses"][0]["past_due"] is False  # checklist in, plans not due until 2027
    conflict = a["hypotheses"][1]
    assert conflict["status"] == "flag_for_researcher" and "wrong" not in conflict["evidence"]


def test_stale_entry_when_built_after_cutoff(public):
    a = rl.assess(rec("3", "300 Spring St", "90013", 1988, "ReinforcedConcrete"), today=TODAY)
    assert "stale_entry" in keys(a) and "unfinished" not in keys(a)


def test_old_concrete_off_the_list_is_not_proven_safe(public):
    a = rl.assess(rec("4", "999 Hill St", "90015", 1965, "ReinforcedConcrete"), today=TODAY)
    assert a["status"] == "not_listed" and keys(a) == ["not_proven_safe"]


def test_zip_must_match_and_other_cities_are_out_of_scope(public):
    assert rl.assess(rec("5", "100 Main St", "90099", 1962), today=TODAY)["status"] == "not_listed"
    assert rl.assess(rec("6", "100 Main St", "90012", 1962, city="Houston"), today=TODAY)["status"] == "not_applicable"


def test_missing_public_data_says_how_to_fix(tmp_path, monkeypatch):
    monkeypatch.setattr(rl, "PUBLIC", tmp_path)
    rl._lists.cache_clear()
    with pytest.raises(rl.PublicDataMissing, match="fetch_public.py"):
        rl.assess(rec("7", "100 Main St", "90012", 1962))
    rl._lists.cache_clear()


def test_extensions_move_the_deadline(public):
    tolled = rl.assess(rec("8", "400 Hope St", "90071", 1965, "ReinforcedConcrete"), today=TODAY)
    s1 = tolled["lists"][0]["steps"][0]
    assert s1["due"] == "2027-01-01" and s1["extended"] and s1["state"] == "not_due_yet"
    assert tolled["hypotheses"][0]["past_due"] is False
    late = rl.assess(rec("9", "500 Hope St", "90071", 1965, "ReinforcedConcrete"), today=TODAY)
    assert late["lists"][0]["overdue_steps"] == ["step_1"]
    assert "due 2023-10-20 (extended)" in late["hypotheses"][0]["evidence"]

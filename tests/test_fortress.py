"""Last Stand LA: the game's code-computed numbers and routes (offline; synthetic TEST data, no kit)."""

from langgraph.store.memory import InMemoryStore
from starlette.testclient import TestClient

from app import fortress, routes

DISTRICT = {"center": {"lat": 34.0, "lon": -118.0}, "radius_m": 900, "seed": 1990,
            "buildings": [{"pid": "1", "label": "TEST-A", "x": 0.0, "z": 0.0, "stories": 9, "hero": True},
                          {"pid": "2", "label": "TEST-B", "x": 150.0, "z": 0.0, "stories": 12, "hero": False},
                          {"pid": "3", "label": "TEST-C", "x": -150.0, "z": 0.0, "stories": 12, "hero": False}],
            "waves": [{"n": 1, "sector": "W", "arrive_s": 20, "size": 290}, {"n": 2, "sector": "N", "arrive_s": 45, "size": 500},
                      {"n": 3, "sector": "E", "arrive_s": 70, "size": 790}]}


def _card(walls, quake, cctv=()):
    return {"scores": {"walls": {"value": walls, "why": "TEST walls; x"}, "quake": {"value": quake, "why": "TEST quake; y"}},
            "images": {"cctv": list(cctv)}}


def _stub(monkeypatch, cards=None):
    cards = cards or {"1": _card(68, 35), "2": _card(70, 70), "3": _card(85, 80)}
    monkeypatch.setattr(fortress, "district", lambda: DISTRICT)
    monkeypatch.setattr(fortress, "dossier", lambda pid: cards[str(pid)])
    monkeypatch.setattr(fortress, "walls", lambda pid, checks=(), notes=None: {"value": cards[str(pid)]["scores"]["walls"]["value"] + 5 * len(checks)})
    monkeypatch.setattr(fortress, "quake_score", lambda pid: {"value": cards[str(pid)]["scores"]["quake"]["value"]})


def test_simplify_keeps_corners_and_drops_jogs():
    square = [[0, 0], [10, 0], [10, 0.2], [10, 10], [0, 10]]
    aer = {"footprint_polygon_m": square + [square[0]], "footprint_sqft": 1000, "parcel_area_sqft": 2000, "height_m": 30}
    fp = fortress._footprint("TEST-A", aer, 9)
    assert len(fp) == 4 and [10.0, -10.0] in fp  # north (+y) becomes -z


def test_footprint_refused_when_outline_or_height_does_not_fit():
    ring = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]
    assert fortress._footprint("TEST-A", {"footprint_polygon_m": ring, "footprint_sqft": 3000, "parcel_area_sqft": 2000}, 9) is None
    assert fortress._footprint("TEST-A", {"footprint_polygon_m": ring, "height_m": 17.3}, 13) is None  # 1.3 m a floor
    assert fortress._footprint("256390", {"footprint_polygon_m": ring, "height_m": 50}, 13) is None


def test_horde_status_bands(monkeypatch):
    _stub(monkeypatch)
    assert fortress.horde_status(1) == {"wave": 1, "sector": "W", "eta_band": "<30s", "size_band": "small"}
    assert fortress.horde_status(3) == {"wave": 3, "sector": "E", "eta_band": ">60s", "size_band": "huge"}
    assert fortress.horde_status(9)["wave"] == 3


def test_fallback_prefers_away_from_the_horde(monkeypatch):
    _stub(monkeypatch, {"1": _card(68, 35), "2": _card(80, 75), "3": _card(80, 75)})
    assert fortress.find_fallback("1", "W")["to_pid"] == "2"  # TEST-B lies east, away from a western wave
    assert fortress.find_fallback("1", "E")["to_pid"] == "3"
    assert "away from the horde" in fortress.find_fallback("1", "W")["reason"]


def test_resolve_is_seeded_and_uses_the_evidence(monkeypatch):
    _stub(monkeypatch)
    a = fortress.resolve("1", 1, 1990, "hold", None, ["look_from_above"])
    assert a == fortress.resolve("1", 1, 1990, "hold", None, ["look_from_above"])
    assert a["walls"] == 73 and a["pid_final"] == "1"  # checks move the walls (stubbed: +5 per check)
    run = fortress.resolve("1", 1, 1990, "run", "3")
    assert run["pid_final"] == "3" and "on foot" in run["why"] and "not an engineering assessment" in run["why"]
    assert fortress.resolve("1", 1, 1990, "run", None)["pid_final"] == "1"  # run with nowhere to go is a hold


def test_game_routes(monkeypatch):
    _stub(monkeypatch)
    monkeypatch.setattr(fortress, "building", lambda pid: next((b for b in DISTRICT["buildings"] if b["pid"] == str(pid)), None))
    routes.app.state.store = InMemoryStore()
    c = TestClient(routes.app)
    assert c.get("/game/district").json()["seed"] == 1990
    assert c.get("/game/dossier/1").json()["scores"]["walls"]["value"] == 68
    assert c.get("/game/dossier/999").status_code == 404 and c.get("/game/dossier/..%2Fx").status_code == 404
    r = c.post("/game/resolve", json={"pid": "1", "wave": 1, "seed": 1990, "action": "run", "to_pid": "3", "checks": []})
    assert r.status_code == 200 and r.json()["pid_final"] == "3"
    assert c.post("/game/resolve", json={"wave": 1}).status_code == 400
    assert c.post("/game/resolve", json={"pid": "1", "to_pid": "777", "action": "run"}).status_code == 404


def test_strict_replay_refuses_uncached_vision(monkeypatch, tmp_path):
    import pytest

    from app import vision

    monkeypatch.setattr(vision, "CACHE", tmp_path)
    monkeypatch.setenv("RADAR_REPLAY_STRICT", "1")
    monkeypatch.setattr(vision, "_invoke", lambda *a, **k: pytest.fail("strict replay must not call the vision model"))
    with pytest.raises(vision.VisionUnavailable):
        vision.ask("TEST-A", "facade", [], "TEST question", ["a", "b"])


def test_door_faces_open_street():
    me = {"pid": "TEST-A", "x": 0.0, "z": 0.0, "footprint": None, "w": 20.0, "d": 20.0}
    # neighbours hard against the west, north and south walls: only the east side is open street
    west = {"pid": "TEST-W", "x": -22.0, "z": 0.0, "footprint": None, "w": 20.0, "d": 20.0}
    north = {"pid": "TEST-N", "x": 0.0, "z": -22.0, "footprint": None, "w": 20.0, "d": 20.0}
    south = {"pid": "TEST-S", "x": 0.0, "z": 22.0, "footprint": None, "w": 20.0, "d": 20.0}
    door = fortress._door(me, [me, west, north, south])
    assert door["facing"] == 90 and door["x"] > 10  # east, just outside the east wall


def test_ground_is_null_without_the_cached_mosaic(monkeypatch, tmp_path):
    monkeypatch.setattr(fortress, "VISION", tmp_path)
    assert fortress._ground() is None
    (tmp_path / fortress.GROUND["image"]).write_bytes(b"\xff\xd8fake")
    assert fortress._ground()["x0"] == fortress.GROUND["x0"]


def test_game_tools_refuse_buildings_outside_the_district(monkeypatch):
    monkeypatch.setattr(fortress, "building", lambda pid: {"pid": "1"} if str(pid) == "1" else None)
    out = fortress.outside("1", "247386")
    assert out and "247386 is not a building in this district" in out["error"] and "Scout property" in out["error"]
    assert fortress.outside("1", None) is None


def test_osm_heights_and_point_in_outline():
    assert fortress._osm_height({"height": "35.2"}) == 35.2
    assert fortress._osm_height({"height": "40 m"}) == 40.0
    assert fortress._osm_height({"building:levels": "5"}) == 19.0
    assert fortress._osm_height({"building": "yes"}) == 12.0
    square = [[0, 0], [10, 0], [10, 10], [0, 10]]
    assert fortress._inside(5, 5, square) and not fortress._inside(15, 5, square)
    assert fortress._area(square) == 100


def test_district_has_no_blocks_without_the_osm_extract(monkeypatch, tmp_path):
    monkeypatch.setattr(fortress, "OSM", tmp_path / "missing.json")
    assert fortress._osm_blocks(34.0, -118.0) == []


def test_night_cases_are_the_queue_cases_in_our_blocks(monkeypatch):
    from app import cases, evidence

    queue = [{"case": "ghost_tenant", "property_id": "9", "suite": "1", "imagery": True, "label": "suite 1: a 2-person office"},  # far away
             {"case": "material_conflict", "property_id": "1", "imagery": True, "material": "Masonry"},
             {"case": "ghost_tenant", "property_id": "2", "suite": "1100", "imagery": True, "label": "suite 1100: a 3-person office"},
             {"case": "stale_entry", "property_id": "3", "imagery": False}]
    where = {"1": {"x": -300.0, "z": -100.0, "label": "TEST-A"}, "2": {"x": 0.0, "z": 0.0, "label": "TEST-B"},
             "3": {"x": 10.0, "z": 10.0, "label": "TEST-C"}, "9": {"x": 5000.0, "z": 0.0, "label": "TEST-far"}}
    monkeypatch.setattr(cases, "ordered", lambda: queue)
    monkeypatch.setattr(fortress, "building", lambda pid: where.get(str(pid)))
    monkeypatch.setattr(evidence, "open_case", lambda pid, suite=None: {"cases": [{"case": "material_conflict" if pid == "1" else "ghost_tenant", "question": "Q?"}]})
    out = fortress.night_cases()
    assert out["total"] == 4 and out["in_area"] == 3
    assert [(c["n"], c["property_id"], c["suite"]) for c in out["cases"]] == [(2, "1", None), (3, "2", "1100")]  # imagery first
    assert out["cases"][0]["stakes"].endswith("CoStar records masonry")
    assert out["cases"][1]["label"] == "suite 1100, TEST-B" and out["cases"][1]["stakes"].startswith("a 3-person office on record")


def test_debrief_draft_is_built_in_code_and_cites_the_player(monkeypatch):
    from app import cases, evidence

    monkeypatch.setattr(cases, "ordered", lambda: [{"case": "ghost_tenant", "property_id": "2", "suite": "1100"}])
    monkeypatch.setattr(fortress, "building", lambda pid: {"label": "TEST-B"})
    seen = {}

    def weigh(pid, case, checks, suite, notes):
        seen.update(case=case, checks=checks)
        return {"verdict": {"hypothesis": "listing_stale", "label": "unresolved", "confidence": 0.42, "text": "Unresolved: x"},
                "correction_draft": None, "next_check": "a site visit", "trail": [{"check": "suite_tour", "finding": "empty"}]}
    monkeypatch.setattr(evidence, "weigh_case", weigh)
    d = fortress.draft("2", "1100", ["suite_tour"], [{"note": "empty", "source": "the player"}])
    assert seen == {"case": "ghost_tenant", "checks": ["suite_tour", "human_report"]}
    assert d["n"] == 1 and d["label"] == "suite 1100, TEST-B" and d["your_report"] == "empty"
    assert d["text"].startswith("No correction drafted yet.") and "Next check: a site visit" in d["text"]


def test_dossier_walls_follow_the_evidence_so_far(monkeypatch):
    from app import evidence

    _stub(monkeypatch)
    monkeypatch.setattr(fortress, "building", lambda pid: {"pid": "1"} if str(pid) == "1" else None)
    monkeypatch.setattr(fortress, "dossier", lambda pid: {"pid": "1", "scores": {"walls": {"value": 68, "label": "unresolved", "why": "priors", "source": "s"}}})
    seen = {}

    def walls(pid, checks=(), notes=None):
        seen.update(checks=list(checks), notes=notes)
        return {"value": 76, "label": "likely", "why": "evidence", "source": "s", "posterior": {}}
    monkeypatch.setattr(fortress, "walls", walls)
    store = InMemoryStore()
    store.put(("notes", "1"), "n1", {"note": "concrete", "source": "the player", "supports": "city_list_current"})
    routes.app.state.store = store
    c = TestClient(routes.app)
    assert c.get("/game/dossier/1").json()["scores"]["walls"]["value"] == 68  # no checks param: unchanged
    w = c.get("/game/dossier/1?checks=look_from_above,compliance_filings,bogus,human_report").json()["scores"]["walls"]
    assert w == {"value": 76, "label": "likely", "why": "evidence", "source": "s"}
    assert seen["checks"] == ["look_from_above", "compliance_filings", "human_report"] and seen["notes"][0]["note"] == "concrete"
    assert "look_from_above" in evidence.CHECK_WHAT


def test_demo_reset_clears_one_nights_traces():
    store = InMemoryStore()
    store.put(("notes", "6375735"), "a", {"note": "concrete"})
    store.put(("notes", "254167#1100"), "b", {"note": "empty"})
    store.put(("corrections",), "c", {"decision": "approve"})
    store.put(("keep",), "d", {"x": 1})
    routes.app.state.store = store
    c = TestClient(routes.app)
    assert c.post("/demo/reset", json={}).status_code == 400
    r = c.post("/demo/reset", json={"confirm": "reset"})
    assert r.status_code == 200 and r.json()["cleared"] == {"notes": 2, "corrections": 1, "outbox": 0, "laststand_cases": 0, "laststand_log": 0}
    assert r.json()["night_log"] == "seeded" and store.get(("laststand_log",), "/latest.md")  # every night starts from the seed
    assert not store.search(("notes",)) and store.search(("keep",))


def test_feed_photos_reach_the_screen_but_never_the_agent(monkeypatch, tmp_path):
    monkeypatch.setattr(fortress, "VISION", tmp_path)
    (tmp_path / "feed_TEST-A_oblique_south.jpg").write_bytes(b"\xff\xd8")
    for k in range(6):
        (tmp_path / f"feed_TEST-A_twin_p0_f{k}.jpg").write_bytes(b"\xff\xd8")
    base = {"pid": "TEST-A", "images": fortress._images("TEST-A")}
    assert base["images"]["drone"] == [] and base["images"]["inside"] == []  # the agent's dossier tool: unchanged
    shown = fortress.with_feeds(base)
    assert shown["images"]["drone"] == ["feed_TEST-A_oblique_south.jpg"] and len(shown["images"]["inside"]) == 6
    assert shown["images"]["inside"][0] == {"face": "f0", "name": "feed_TEST-A_twin_p0_f0.jpg"}


def test_suite_sweep_answer_key_comes_from_code(monkeypatch):
    from app import cases, evidence

    fortress._suites.cache_clear()
    monkeypatch.setattr(cases, "ordered", lambda: [
        {"case": "ghost_tenant", "property_id": "2", "suite": "1100", "label": "suite 1100: a 3-person office"},
        {"case": "ghost_tenant", "property_id": "2", "suite": "1400", "label": "suite 1400: a 12-person office"},
        {"case": "material_conflict", "property_id": "2"}])
    monkeypatch.setattr(fortress, "building", lambda pid: {"label": "TEST-B"})
    monkeypatch.setattr(evidence, "run_check", lambda pid, check, case, suite, notes: {"finding": f"{check} {suite}", "why": "w"})
    verdicts = {"1100": ("leaning", "listing_stale"), "1400": ("unresolved", "still_there")}
    monkeypatch.setattr(evidence, "weigh_case", lambda pid, case, checks, suite, notes: {"verdict": {
        "label": verdicts[suite][0], "hypothesis": verdicts[suite][1], "confidence": 0.5, "text": "t"}})
    s = fortress.suites("2")
    assert [(x["n"], x["suite"], x["answer"]["group"]) for x in s["suites"]] == [(1, "1100", "there"), (2, "1400", "cant_tell")]
    assert s["suites"][0]["who"] == "a 3-person office" and len(s["suites"][0]["clues"]) == 3
    fortress._suites.cache_clear()


def test_roof_facts_are_counts_only(monkeypatch):
    monkeypatch.setattr(fortress, "_aerial", lambda pid: {"roof_shape": "flat", "roof_objects": {"skylight": 8}, "capture_date": "2025-12-01"})
    r = fortress.roof("TEST-A")
    assert r["objects"] == {"skylight": 8} and r["capture"] == "2025-12" and "illustrative" in r["note"]
    monkeypatch.setattr(fortress, "_aerial", lambda pid: None)
    assert fortress.roof("TEST-A") is None


def test_mesh_route_serves_only_a_cached_mesh(monkeypatch, tmp_path):
    from app import costar

    monkeypatch.setattr(routes, "MESH_DIR", tmp_path)
    monkeypatch.setattr(costar, "get", lambda pid: {"matterport_model_ids": ["M1"]} if pid == "1" else {})
    (tmp_path / "M1_50k.obj").write_text("v 0 0 0\n")
    c = TestClient(routes.app)
    r = c.get("/game/mesh/1")
    assert r.status_code == 200 and r.text.startswith("v ")
    assert c.get("/game/mesh/2").status_code == 404 and c.get("/game/mesh/..%2Fx").status_code == 404


def test_solar_stamps_come_from_the_screen_readiness():
    assert fortress._SOLAR_STAMP["ready"] == "go_solar" and fortress._SOLAR_STAMP["reroof_first"] == "reroof_first"
    assert fortress._SOLAR_STAMP["inspect"] == fortress._SOLAR_STAMP["unknown"] == "inspect_first"


def test_stale_stamp_mapping():
    assert fortress._STALE_STAMP == {"year_is_renovation": "same_building", "replaced": "replaced"}


def test_guards_reject_padded_ids_and_running_to_yourself(monkeypatch):
    monkeypatch.setattr(fortress, "building", lambda pid: {"pid": pid} if pid == "1" else None)
    assert fortress.outside(" 1") and fortress.outside("1 ") and fortress.outside("1") is None
    _stub(monkeypatch)
    assert fortress.resolve("1", 1, 2026, "run", "1")["pid_final"] == "1" and "on foot" not in fortress.resolve("1", 1, 2026, "run", "1")["why"]

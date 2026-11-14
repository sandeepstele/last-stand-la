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

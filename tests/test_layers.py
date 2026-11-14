"""Data-layer wiring: CoStar kit + live Vexcel (cached) -> verifier and solar. All inputs synthetic:
a tiny fake kit in tmp_path and a mocked Vexcel response (real values are licensed)."""

import asyncio
import json
from types import SimpleNamespace

import pytest
from langgraph.store.memory import InMemoryStore

from app import costar, layers, scene, tools, vexcel
from app.verify import Aerial, Records, investigate


def _square(lon, lat, half_deg):
    pts = [(lon - half_deg, lat - half_deg), (lon + half_deg, lat - half_deg), (lon + half_deg, lat + half_deg),
           (lon - half_deg, lat + half_deg), (lon - half_deg, lat - half_deg)]
    return "POLYGON((" + ", ".join(f"{x} {y}" for x, y in pts) + "))"


def _raw(footprint_sqft, lon=-95.405, lat=29.755):
    return {"features": [{
        "geometry": {"type": "Polygon", "coordinates": [[[lon - .003, lat - .003], [lon + .003, lat - .003], [lon + .003, lat + .003],
                                                          [lon - .003, lat + .003], [lon - .003, lat - .003]]]},
        "properties": {"metadata.collection": "us-tx-houston-2026", "metadata.ortho-date-estimate": "2026-01-03", "structure.count": 1,
                       "structures": [{"footprint.area": footprint_sqft, "footprint.wkt": _square(lon, lat, 0.002),
                                       "roof-characteristics.height": 32.0, "roof-characteristics.shape.value": "flat",
                                       "roof-characteristics.condition.precise-value": 4.4, "roof-objects.roof-vent.count": 12}]}}]}


@pytest.fixture
def kit(tmp_path, monkeypatch):
    d = tmp_path / "kit"
    (d / "data").mkdir(parents=True)
    (d / "schemas").mkdir()
    (d / "schemas" / "enums.json").write_text(json.dumps({"PropertyType": {"5": "Industrial", "11": "Multifamily"}}))
    addr = {"streetNumber": "1", "streetName": "Synthetic", "streetType": "Way", "city": "Houston", "state": "TX",
            "latitude": 29.755, "longitude": -95.405}
    rows = [
        {"id": 900001, "propertyType": 5, "primaryAddress": addr, "grossBuildingAreaSquareFeet": 240_000, "numStoriesAboveGrade": 1,
         "constructionEvents": [{"eventType": 2, "year": 2019}], "propertyIndustrial": {"isOwnerOccupied": True}},
        {"id": 900002, "propertyType": 5, "primaryAddress": addr, "grossBuildingAreaSquareFeet": 1_230_000, "numStoriesAboveGrade": 1,
         "constructionEvents": [{"eventType": 2, "year": 2005}]},
    ]
    (d / "data" / "commercial-property.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    (d / "data" / "location-occupancy.jsonl").write_text(json.dumps(
        {"propertyId": 900001, "toDate": None, "spaces": [{"squareFeetOccupied": 240_000}],
         "leaseDeal": {"expirationDate": "2040-06-30T00:00:00"}}) + "\n")
    (d / "commercial-properties.csv").write_text("PropertyId,MatterportModelId\n900001,\n")
    monkeypatch.setenv("COSTAR_KIT_DIR", str(d))
    monkeypatch.setattr(layers, "FIXTURES", tmp_path / "fixtures")
    for f in (costar._index, costar._enums, costar._tenancies):
        f.cache_clear()
    yield d
    for f in (costar._index, costar._enums, costar._tenancies):
        f.cache_clear()


@pytest.fixture
def vexcel_calls(monkeypatch):
    calls = []

    def fake(lat, lon, **kw):  # both synthetic buildings share a point; next_small returns the shed
        calls.append((lat, lon))
        return _raw(2_065 if fake.next_small else 238_000)

    fake.next_small = False
    monkeypatch.setattr(vexcel, "property_extract", fake)
    return calls, fake


def test_kit_record_and_live_vexcel_feed_the_verifier(kit, vexcel_calls):
    calls, _ = vexcel_calls
    b = layers.load_building("900001")
    assert b.records.area_basis == "gross" and b.records.rba_sqft == 240_000 and b.records.building_type == "industrial"
    assert b.provenance["costar"]["source"].startswith("costar-kit") and not b.synthetic
    assert b.link_problem is None and len(calls) == 1
    assert (layers.FIXTURES / "vexcel" / "900001.json").exists()  # cached (gitignored in the real repo)
    layers.load_building("900001")
    assert len(calls) == 1  # second load reads the cache
    assert investigate(b.records, b.aerial).verdict == "consistent"  # 238,000 x 1 vs 240,000 gross


def test_solar_screen_uses_kit_leases_and_city(kit, vexcel_calls):
    s = layers.screen_solar(layers.load_building("900001"))
    assert s.status == "screened" and s.readiness == "ready"  # 2019 roof, condition 4.4
    assert s.deal_fit == "strong"  # owner-occupied + 100% leased past the horizon
    assert s.inputs_status["load"] == "sourced"


def test_wrong_structure_is_refused_not_flagged(kit, vexcel_calls):
    _, fake = vexcel_calls
    fake.next_small = True
    b = layers.load_building("900002")
    assert b.link_problem and "another structure" in b.link_problem
    out = asyncio.run(tools.verify_building.coroutine(property_id="900002", runtime=SimpleNamespace(store=None)))
    assert out["verdict"] == "check_link"
    rt = SimpleNamespace(store=InMemoryStore())
    assert asyncio.run(tools.retrofit.coroutine(property_id="900002", runtime=rt))["status"] == "check_link"


def test_retrofit_tool_on_kit_building(kit, vexcel_calls):
    out = asyncio.run(tools.retrofit.coroutine(property_id="900001", runtime=SimpleNamespace(store=InMemoryStore())))
    assert out["status"] == "screened" and out["system_kw"] > 0 and out["synthetic_data"] is False
    assert out["floor_area_check"].startswith("consistent")
    assert "keepout_sqft" in out["placeholders"]


def test_synthetic_test_a_still_works_in_auto_mode(monkeypatch):
    monkeypatch.delenv("RADAR_LAYER_COSTAR", raising=False)
    monkeypatch.delenv("RADAR_LAYER_VEXCEL", raising=False)
    b = layers.load_building("TEST-A")
    assert b.synthetic and b.records.area_basis == "rentable"
    s = layers.screen_solar(b)
    assert s.status == "screened" and s.roof_breakdown["equipment_keepout_sqft"] == 6 * 150 + 4 * 60


def test_bad_mode_is_a_readable_error(monkeypatch):
    monkeypatch.setenv("RADAR_LAYER_VEXCEL", "kit")
    with pytest.raises(layers.LayerError, match="RADAR_LAYER_VEXCEL must be one of"):
        layers.get_aerial("TEST-A")


def test_place_solar_draws_nothing_for_the_wrong_structure(kit, vexcel_calls):
    _, fake = vexcel_calls
    fake.next_small = True
    rt = SimpleNamespace(store=None, stream_writer=lambda e: pytest.fail("nothing should be drawn"), config={})
    assert "nothing drawn" in asyncio.run(scene.place_solar.coroutine(property_id="900002", runtime=rt))


@pytest.mark.parametrize("listed,basis,expected", [(250_000, "gross", "within"), (250_000, "rentable", "above"),
                                                   (215_000, "gross", "within"), (205_000, "gross", "below")])
def test_gross_area_uses_its_own_band(listed, basis, expected):
    inv = investigate(Records(rba_sqft=listed, stories=1, area_basis=basis), Aerial(footprint_sqft=238_000))
    assert inv.initial.status == expected


# ------------------------------------------------------------- Matterport team token + twin link check


def _layout(lat, lon):
    return {"id": "TWINx00001", "name": "Synthetic lobby", "geolocation": {"lat": str(lat), "long": str(lon)},
            "floors": [{"id": "f1", "sequence": 0, "label": "Floor 1"}],
            "locations": [{"id": f"l{i}", "position": {"x": i * 2.0, "y": 0.0, "z": 0.1}, "floor": {"id": "f1"}, "room": None}
                          for i in range(4)]}


def test_team_token_is_preferred_and_auto_mode_caches(tmp_path, monkeypatch):
    from app import matterport

    monkeypatch.setattr(matterport, "FIXTURES", tmp_path)
    monkeypatch.delenv("RADAR_MATTERPORT", raising=False)  # default auto
    monkeypatch.setenv("MATTERPORT_TOKEN_ID", "personal-id")
    monkeypatch.setenv("MATTERPORT_TOKEN_SECRET", "personal-secret")
    monkeypatch.setenv("MATTERPORT_TEAM_TOKEN_ID", "team-id")
    monkeypatch.setenv("MATTERPORT_TEAM_TOKEN_SECRET", "team-secret")
    sent = []

    def post(url, json, auth, timeout):
        sent.append((auth, json["query"]))
        return SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"data": {"model": _layout(29.75, -95.40)}})

    monkeypatch.setattr(matterport.httpx, "post", post)
    assert matterport.token_label() == "team"
    matterport.fetch_layout("TWINx00001")
    matterport.fetch_layout("TWINx00001")  # second call replays the cache
    assert len(sent) == 1 and sent[0][0] == ("team-id", "team-secret")
    assert "mutation" not in sent[0][1] and "geolocation" in sent[0][1]


def test_invisible_model_is_a_readable_error(tmp_path, monkeypatch):
    from app import matterport

    monkeypatch.setattr(matterport, "FIXTURES", tmp_path)
    monkeypatch.setenv("RADAR_MATTERPORT", "live")
    monkeypatch.setenv("MATTERPORT_TEAM_TOKEN_ID", "team-id")
    monkeypatch.setenv("MATTERPORT_TEAM_TOKEN_SECRET", "team-secret")
    monkeypatch.setattr(matterport.httpx, "post", lambda *a, **k: SimpleNamespace(
        raise_for_status=lambda: None, json=lambda: {"data": {"model": None}}))
    with pytest.raises(matterport.MatterportError, match="not visible to the team token"):
        matterport.fetch_layout("TWINx00001")


@pytest.mark.parametrize("twin_at,used", [((29.7552, -95.4051), True), ((29.7600, -95.4050), False)])
def test_twin_far_from_the_costar_point_is_refused(monkeypatch, twin_at, used):
    from app import matterport

    monkeypatch.setattr(matterport, "fetch_layout", lambda mid: _layout(*twin_at))
    rec = {"matterport_model_id": "TWINx00001", "latitude": 29.755, "longitude": -95.405}
    if used:  # ~25 m away
        model_id, twin = layers.get_twin("900001", rec)
        assert model_id == "TWINx00001" and twin is not None
    else:  # ~560 m away
        with pytest.raises(layers.LayerError, match="probably not this building"):
            layers.get_twin("900001", rec)


def test_best_linked_twin_is_the_largest_nearby_scan(monkeypatch):
    from app import matterport

    def layout(mid):
        base = _layout(*{"SMALLnear1": (29.7551, -95.4050), "BIGnear001": (29.7552, -95.4051), "HUGEfar001": (29.7650, -95.4050)}[mid])
        base["floors"][0]["dimensions"] = {"areaFloor": {"SMALLnear1": 900, "BIGnear001": 60_000, "HUGEfar001": 250_000}[mid]}
        return base

    monkeypatch.setattr(matterport, "fetch_layout", layout)
    rec = {"matterport_model_ids": ["SMALLnear1", "HUGEfar001", "BIGnear001"], "latitude": 29.755, "longitude": -95.405}
    model_id, twin = layers.get_twin("900001", rec)
    assert model_id == "BIGnear001" and twin is not None and rec["matterport_model_id"] == "BIGnear001"

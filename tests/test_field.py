"""Field checks from the Radar Field iOS app (RoomPlan JSON) and the rules that keep them honest."""

import asyncio
import json
import uuid
from types import SimpleNamespace

import pytest
from langgraph.store.memory import InMemoryStore
from starlette.testclient import TestClient

from app import field
from app.verify import Aerial, Records, investigate


def _transform(y: float, nested: bool = False):
    cols = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, y, 0, 1]]  # column-major, translation in column 3
    return cols if nested else [v for c in cols for v in c]


def _room(floor_y=-1.4, wall_h=2.74, w=5.0, d=4.0, nested=False):
    walls = [{"dimensions": [w, wall_h, 0], "transform": _transform(0, nested)} for _ in range(2)]
    walls += [{"dimensions": [d, wall_h, 0], "transform": _transform(0, nested)} for _ in range(2)]
    corners = [[-w / 2, -d / 2, 0], [w / 2, -d / 2, 0], [w / 2, d / 2, 0], [-w / 2, d / 2, 0]]
    return {"walls": walls, "floors": [{"dimensions": [w, d, 0], "transform": _transform(floor_y, nested), "polygonCorners": corners}]}


def _payload(roomplan, *, stand_in=False, searched_below=False, at_entrance=True, property_id="TEST-A", rtype="CapturedRoom"):
    return {
        "schema": "radar-field-scan/1", "scan_id": str(uuid.uuid4()), "property_id": property_id,
        "stand_in": stand_in, "searched_below": searched_below, "first_room_at_entrance": at_entrance,
        "roomplan_type": rtype, "summary": {"ceiling_height_m": 2.74, "warnings": []}, "roomplan": roomplan,
    }


STORY_A = (Records(rba_sqft=38_000, stories=2), Aerial(footprint_sqft=13_700, height_m=7.5))
TWO_LEVELS = {"rooms": [_room(-1.4), _room(-4.5)]}


# ------------------------------------------------------------- parsing and validation


def test_parse_single_room():
    m = field.parse_roomplan(_room())
    assert (m["ceiling_height_m"], m["net_area_m2"], m["level_offsets_m"], m["rooms"]) == (2.74, 20.0, [0.0], 1)


def test_parse_structure_with_two_levels_and_nested_transforms():
    scan = field.parse_payload(_payload({"rooms": [_room(-1.4, nested=True), _room(-4.5, nested=True)]}, rtype="CapturedStructure"))
    assert scan.level_offsets_m == [-3.1, 0.0] and scan.levels_below == [-3.1] and scan.rooms == 2


def test_lower_level_needs_the_first_room_at_the_entrance():
    """Regression: scanning upstairs first made the lobby look like a basement."""
    scan = field.parse_payload(_payload(TWO_LEVELS, at_entrance=False))
    assert scan.level_offsets_m == [-3.1, 0.0] and scan.levels_below == []


def test_ceiling_above_roomplan_limit_is_unverified():
    scan = field.parse_payload(_payload(_room(wall_h=4.2)))
    assert scan.ceiling_height_m is None and any("3.6 m" in f for f in scan.flags)


def test_unparseable_roomplan_falls_back_to_phone_numbers():
    payload = _payload({"something": "else"})
    payload["summary"] = {"ceiling_height_m": 2.6, "net_area_m2": 18.0, "level_offsets_m": [0.0], "rooms": 1}
    scan = field.parse_payload(payload)
    assert scan.ceiling_height_m == 2.6 and scan.net_area_m2 == 18.0 and any("phone" in f for f in scan.flags)


@pytest.mark.parametrize("bad", ["..", ".hidden", "../etc", "", "x" * 80, "a/b", "a.b"])
def test_rejects_bad_property_ids(bad):
    with pytest.raises(field.FieldScanError):
        field.parse_payload(_payload(_room(), property_id=bad))


def test_booleans_are_strict():
    p = _payload(_room())
    p["searched_below"] = "false"
    assert field.parse_payload(p).searched_below is False
    p["searched_below"] = "yes please"
    with pytest.raises(field.FieldScanError):
        field.parse_payload(p)


# ------------------------------------------------------------- verifier rules


def test_ceiling_height_never_creates_a_floor():
    scan = field.parse_payload(_payload(_room()))
    assert field.max_floors(7.5, scan) == 2
    inv = investigate(*STORY_A, None, scan)
    fc = next(h for h in inv.hypotheses if h.key == "floor_count")
    assert fc.status == "ruled_out" and "field" in fc.tester
    assert "floor_count" not in inv.applied and inv.verdict == "worth_a_look"


def test_no_lower_level_counts_only_when_someone_looked():
    status = lambda s: next(h.status for h in investigate(*STORY_A, None, s).hypotheses if h.key == "below_grade")
    assert status(field.parse_payload(_payload(_room(), searched_below=False))) == "untested"
    assert status(field.parse_payload(_payload(_room(), searched_below=True))) == "ruled_out"


def test_stand_in_scan_never_changes_a_verdict():
    stand_in = field.parse_payload(_payload(TWO_LEVELS, stand_in=True, searched_below=True))
    with_scan, without = investigate(*STORY_A, None, stand_in), investigate(*STORY_A)
    assert with_scan.verdict == without.verdict
    assert [h.status for h in with_scan.hypotheses] == [h.status for h in without.hypotheses]


def test_field_lower_level_is_capped_at_the_scanned_area():
    scan = field.parse_payload(_payload(TWO_LEVELS))
    bg = next(h for h in investigate(*STORY_A, None, scan).hypotheses if h.key == "below_grade")
    assert bg.status == "supported" and bg.tester == "field"
    assert bg.extra_gross_sqft == scan.net_area_sqft  # 40 m² of rooms, not a whole footprint


# ------------------------------------------------------------- Store, route and tools


def test_store_round_trip_and_stand_in_filter():
    store = InMemoryStore()

    async def go():
        await field.save_scan(store, _payload(_room(), stand_in=True))
        assert await field.latest_scan(store, "TEST-A") is None
        assert (await field.latest_scan(store, "TEST-A", include_stand_in=True)).stand_in

    asyncio.run(go())


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("RADAR_FIELD_TOKEN", "secret")
    from app.routes import app

    app.state.store = InMemoryStore()
    yield TestClient(app)
    app.state.store = None


def test_upload_requires_token_and_returns_a_preview(client):
    body = json.dumps(_payload(_room(), stand_in=True))
    assert client.post("/field/scan", content=body).status_code == 401
    r = client.post("/field/scan", content=body, headers={"X-Radar-Token": "secret"})
    assert r.status_code == 200, r.text
    msg = r.json()["message"]
    assert msg.startswith("Stand-in room, preview only")
    assert "at most 2 floor(s) fit in 7.5 m (listed: 2)" in msg  # from the synthetic TEST-A fixtures
    assert client.get("/field/scans/TEST-A").status_code == 401
    listed = client.get("/field/scans/TEST-A", headers={"X-Radar-Token": "secret"}).json()["scans"]
    assert len(listed) == 1 and listed[0]["ceiling_height_m"] == 2.74


def test_uploads_are_refused_when_no_token_is_configured(monkeypatch):
    monkeypatch.delenv("RADAR_FIELD_TOKEN", raising=False)
    from app.routes import app

    r = TestClient(app).post("/field/scan", content=json.dumps(_payload(_room())))
    assert r.status_code == 503


def test_upload_rejects_bad_payloads(client):
    headers = {"X-Radar-Token": "secret"}
    assert client.post("/field/scan", content="not json", headers=headers).status_code == 400
    bad = _payload(_room(), property_id="..")
    assert client.post("/field/scan", content=json.dumps(bad), headers=headers).status_code == 400


def test_verify_building_tool_loads_layers_and_the_latest_real_scan():
    from app.tools import field_check, retrofit, verify_building

    store = InMemoryStore()
    runtime = SimpleNamespace(store=store, stream_writer=lambda _: None, config={})

    async def go():
        await field.save_scan(store, _payload(_room(), stand_in=False))
        out = await verify_building.coroutine(property_id="TEST-A", runtime=runtime)
        statuses = {h["key"]: h["status"] for h in out["hypotheses"]}
        assert statuses["floor_count"] == "ruled_out"
        assert out["synthetic_data"] is True and out["provenance"]["costar"]["synthetic"] is True
        assert "at most 2 floor(s)" in out["field_check"]
        fix = await retrofit.coroutine(property_id="TEST-A", city="Houston, TX", runtime=runtime)
        assert fix["placeholders"] and fix["synthetic_data"] is True
        assert (await field_check.coroutine(property_id="TEST-A", runtime=runtime))["ceiling_height_m"] == 2.74
        assert (await field_check.coroutine(property_id="NOPE", runtime=runtime))["field_check"] is None

    asyncio.run(go())

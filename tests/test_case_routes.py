"""Case queue, decision and evidence-image routes (no network; the queue is stubbed)."""

from langgraph.store.memory import InMemoryStore
from starlette.testclient import TestClient

from app import routes, vision


def client(monkeypatch, tmp_path):
    monkeypatch.setattr(routes, "_queue", lambda: {"counts": {"material_conflict": 1}, "total": 1, "top": [{"case": "material_conflict", "property_id": "X1"}]})
    monkeypatch.setattr(vision, "CACHE", tmp_path)
    routes.app.state.store = InMemoryStore()
    return TestClient(routes.app)


def test_queue(monkeypatch, tmp_path):
    r = client(monkeypatch, tmp_path).get("/cases/queue")
    assert r.status_code == 200 and r.json()["counts"] == {"material_conflict": 1}


def test_decision_is_recorded_not_sent(monkeypatch, tmp_path):
    c = client(monkeypatch, tmp_path)
    r = c.post("/cases/decision", json={"property_id": "247337", "case": "material_conflict", "decision": "approve", "draft": "DRAFT ..."})
    assert r.status_code == 200 and r.json()["status"] == "recorded" and "nothing is sent" in r.json()["note"]
    assert routes.app.state.store.search(("corrections",))[0].value["decision"] == "approve"
    assert c.post("/cases/decision", json={"property_id": "247337", "decision": "maybe"}).status_code == 400
    assert c.post("/cases/decision", json={"property_id": "../x", "decision": "approve"}).status_code == 400


def test_evidence_image_serves_only_cached_jpegs(monkeypatch, tmp_path):
    (tmp_path / "X1_ortho_latest.jpg").write_bytes(b"\xff\xd8fake")
    c = client(monkeypatch, tmp_path)
    r = c.get("/evidence/image/X1_ortho_latest.jpg")
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    assert c.get("/evidence/image/missing.jpg").status_code == 404
    assert c.get("/evidence/image/..%2Fsecrets.jpg").status_code == 404

import asyncio
import json

from app.routes import healthz


def test_healthz_reports_effective_layer_defaults(monkeypatch):
    monkeypatch.delenv("RADAR_LAYER_COSTAR", raising=False)
    monkeypatch.delenv("RADAR_LAYER_VEXCEL", raising=False)
    response = asyncio.run(healthz(None))
    body = json.loads(response.body)
    assert body["layers"] == {"costar": "auto", "vexcel": "auto"}

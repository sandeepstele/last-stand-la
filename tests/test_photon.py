"""app/photon.py talks to the local iMessage bridge; these tests mock the bridge, no network."""

import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest
from langgraph.store.memory import InMemoryStore

from app import photon, tools


@pytest.fixture
def bridge_env(monkeypatch):
    monkeypatch.setenv("PHOTON_BRIDGE_TOKEN", "test-token")
    monkeypatch.setenv("PHOTON_BRIDGE_URL", "http://bridge.test:8787/")


def test_not_configured_without_token(monkeypatch):
    monkeypatch.delenv("PHOTON_BRIDGE_TOKEN", raising=False)
    assert asyncio.run(photon.send("hi")) == {"status": "not_configured"}


def test_sends_with_bearer_token(bridge_env):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"status": "sent", "count": 1})

    out = asyncio.run(photon.send("2,775 kW roof ready", transport=httpx.MockTransport(handler)))
    assert out == {"status": "sent"}
    assert seen == {"url": "http://bridge.test:8787/send", "auth": "Bearer test-token",
                    "body": {"text": "2,775 kW roof ready", "to": "owner"}}


def test_bridge_error_is_reported_not_raised(bridge_env):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(502, json={"status": "error", "detail": "Target not allowed for this project"})

    out = asyncio.run(photon.send("hi", transport=httpx.MockTransport(handler)))
    assert out == {"status": "http_502", "detail": "Target not allowed for this project"}


def test_bridge_down_is_offline(bridge_env):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    assert asyncio.run(photon.send("hi", transport=httpx.MockTransport(handler))) == {"status": "bridge_offline"}


def test_notify_me_texts_and_keeps_an_inbox_copy(monkeypatch):
    async def fake_send(text, to="owner"):
        return {"status": "sent"}

    monkeypatch.setattr(photon, "send", fake_send)
    store = InMemoryStore()
    out = asyncio.run(tools.notify_me.coroutine(text="TEST-A: re-roof first", runtime=SimpleNamespace(store=store)))
    assert out.startswith("Texted the user")
    saved = store.search(("outbox",))
    assert len(saved) == 1 and saved[0].value["delivery"] == {"status": "sent"}


def test_notify_me_falls_back_to_inbox_when_bridge_is_down(monkeypatch):
    async def fake_send(text, to="owner"):
        return {"status": "bridge_offline"}

    monkeypatch.setattr(photon, "send", fake_send)
    out = asyncio.run(tools.notify_me.coroutine(text="hi", runtime=SimpleNamespace(store=InMemoryStore())))
    assert "bridge is not running" in out

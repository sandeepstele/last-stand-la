"""Read-only Matterport Model API client.

The Model API token is "all-access": it can archive models and buy MatterPaks.
This module therefore only ever sends the whitelisted read-only queries below,
and the agent reaches Matterport only through it.

Modes (env RADAR_MATTERPORT):
  live   -> call the API and write the response through to fixtures/matterport/
  cached -> replay fixtures only (no network)
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

import httpx

ENDPOINT = "https://api.matterport.com/api/models/graph"
FIXTURES = Path(__file__).resolve().parent.parent / "fixtures" / "matterport"
_MODEL_ID = re.compile(r"^[A-Za-z0-9]{6,32}$")

# The only queries this client will ever send. No mutations.
_MODELS_QUERY = '{ models(query: "*") { totalResults results { id name created visibility } } }'
_LAYOUT_QUERY = (
    '{ model(id: "%s") { id name '
    "floors { id sequence label } "
    "locations { id label position { x y z } floor { id } room { id } } } }"
)


class MatterportError(RuntimeError):
    pass


def _mode() -> str:
    return os.environ.get("RADAR_MATTERPORT", "cached").strip().lower()


def _post(query: str) -> dict[str, Any]:
    token_id = os.environ.get("MATTERPORT_TOKEN_ID")
    secret = os.environ.get("MATTERPORT_TOKEN_SECRET")
    if not token_id or not secret:
        raise MatterportError("MATTERPORT_TOKEN_ID / MATTERPORT_TOKEN_SECRET are not set")
    resp = httpx.post(ENDPOINT, json={"query": query}, auth=(token_id, secret), timeout=25)
    resp.raise_for_status()
    body = resp.json()
    if body.get("errors"):
        raise MatterportError(json.dumps(body["errors"])[:500])
    return body["data"]


def list_models() -> list[dict[str, Any]]:
    """Models visible to this token. A sandbox account only sees its demo model."""
    return _post(_MODELS_QUERY)["models"]["results"]


def fetch_layout(model_id: str) -> dict[str, Any]:
    """Floors and scan locations for one model (live or cached)."""
    if not _MODEL_ID.match(model_id):
        raise MatterportError(f"invalid model id: {model_id!r}")
    path = FIXTURES / f"{model_id}.json"
    if _mode() == "cached":
        if not path.exists():
            raise MatterportError(f"no cached fixture for {model_id}; run in live mode once")
        return json.loads(path.read_text())
    layout = _post(_LAYOUT_QUERY % model_id)["model"]
    FIXTURES.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(layout, indent=1))
    return layout

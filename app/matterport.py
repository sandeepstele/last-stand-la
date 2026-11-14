"""Read-only Matterport Model API client.

The Model API token is "all-access": it can archive models and buy MatterPaks.
This module therefore only ever sends the whitelisted read-only queries below,
and the agent reaches Matterport only through it.

Token: the HackPrinceton team token (MATTERPORT_TEAM_TOKEN_ID / _SECRET) sees the event's
models, including the twins the CoStar kit links to properties. The personal sandbox token
(MATTERPORT_TOKEN_ID / _SECRET) is the fallback and only sees its own demo model.

Modes (env RADAR_MATTERPORT), default auto:
  auto   -> the cached layout if there is one, else live
  live   -> call the API and write the response through to fixtures/matterport/ (gitignored)
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
_TOKENS = (("MATTERPORT_TEAM_TOKEN", "team"), ("MATTERPORT_TOKEN", "personal"))

# The only queries this client will ever send. No mutations.
_MODELS_QUERY = '{ models(query: "*") { totalResults results { id name created visibility } } }'
_LAYOUT_QUERY = (
    '{ model(id: "%s") { id name geolocation { lat long } dimensions { areaFloor units } '
    "floors { id sequence label dimensions { areaFloor } } "
    "locations { id label position { x y z } floor { id } room { id } } } }"
)


class MatterportError(RuntimeError):
    pass


def mode() -> str:
    m = os.environ.get("RADAR_MATTERPORT", "auto").strip().lower()
    if m not in ("auto", "live", "cached"):
        raise MatterportError("RADAR_MATTERPORT must be auto, live or cached")
    return m


def token_label() -> str | None:
    """Which token a live call would use: "team", "personal" or None."""
    for prefix, label in _TOKENS:
        if os.environ.get(f"{prefix}_ID") and os.environ.get(f"{prefix}_SECRET"):
            return label
    return None


def _post(query: str) -> dict[str, Any]:
    for prefix, _ in _TOKENS:
        token_id, secret = os.environ.get(f"{prefix}_ID"), os.environ.get(f"{prefix}_SECRET")
        if token_id and secret:
            break
    else:
        raise MatterportError("no Matterport token: set MATTERPORT_TEAM_TOKEN_ID / _SECRET in .env")
    resp = httpx.post(ENDPOINT, json={"query": query}, auth=(token_id, secret), timeout=25)
    resp.raise_for_status()
    body = resp.json()
    if body.get("errors"):
        raise MatterportError(json.dumps(body["errors"])[:500])
    return body["data"]


def list_models() -> list[dict[str, Any]]:
    """Models visible to this token (the team token sees the event's models)."""
    return _post(_MODELS_QUERY)["models"]["results"]


def fetch_layout(model_id: str) -> dict[str, Any]:
    """Floors, scan locations, geolocation and scanned floor area for one model."""
    if not _MODEL_ID.match(model_id):
        raise MatterportError(f"invalid model id: {model_id!r}")
    path = FIXTURES / f"{model_id}.json"
    m = mode()
    if m == "cached" or (m == "auto" and path.exists()):
        if not path.exists():
            raise MatterportError(f"no cached fixture for {model_id}; run in live or auto mode once")
        return json.loads(path.read_text())
    layout = _post(_LAYOUT_QUERY % model_id)["model"]
    if layout is None:
        raise MatterportError(f"model {model_id} is not visible to the {token_label()} token")
    FIXTURES.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(layout, indent=1))
    return layout

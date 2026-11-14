"""HTTP routes mounted on the Agent Server through langgraph.json "http.app" (works the same
under `langgraph dev --host 0.0.0.0`, port 2024).

POST /field/scan              Radar Field iOS upload; header X-Radar-Token must match RADAR_FIELD_TOKEN
GET  /field/scans/{property}  stored scans for a property (same token)
GET  /healthz                 configuration check (no secrets)

Uploads are refused when RADAR_FIELD_TOKEN is unset. Custom routes skip the server's own auth,
so the token is the only gate. Handlers do no blocking I/O on the event loop (langgraph dev's
blockbuster rejects it): the Store is async and fixture reads go through asyncio.to_thread.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import os

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from app import field, layers

MAX_UPLOAD_BYTES = 15 * 1024 * 1024


def _store(request: Request):
    override = getattr(request.app.state, "store", None)  # tests inject an InMemoryStore
    if override is not None:
        return override
    from langgraph.config import get_store

    return get_store()


def _auth(request: Request) -> JSONResponse | None:
    token = os.environ.get("RADAR_FIELD_TOKEN", "")
    if not token:
        return JSONResponse({"error": "uploads are disabled: the server has no RADAR_FIELD_TOKEN"}, status_code=503)
    supplied = request.headers.get("x-radar-token", "")
    if not hmac.compare_digest(supplied.encode(), token.encode()):
        return JSONResponse({"error": "missing or wrong upload token"}, status_code=401)
    return None


def _context(property_id: str) -> tuple[float | None, int | None]:
    try:
        b = layers.load_building(property_id)
        return b.aerial.height_m, b.records.stories
    except Exception:  # no cached data for this property yet: preview without the floor bound
        return None, None


async def post_scan(request: Request) -> JSONResponse:
    if (denied := _auth(request)) is not None:
        return denied
    body = await request.body()
    if len(body) > MAX_UPLOAD_BYTES:
        return JSONResponse({"error": "upload too large"}, status_code=413)
    try:
        scan = await field.save_scan(_store(request), json.loads(body))
    except (json.JSONDecodeError, field.FieldScanError) as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    height, stories = await asyncio.to_thread(_context, scan.property_id)
    return JSONResponse({"ok": True, "message": field.preview(scan, height, stories), "field_scan": scan.to_dict()})


async def get_scans(request: Request) -> JSONResponse:
    if (denied := _auth(request)) is not None:
        return denied
    property_id = request.path_params["property_id"]
    scans = await field.list_scans(_store(request), property_id)
    return JSONResponse({"property_id": property_id, "scans": [s.to_dict() for s in scans]})


async def healthz(request: Request) -> JSONResponse:
    return JSONResponse({
        "ok": True,
        "models": {"orchestrator": os.environ.get("RADAR_ORCH_MODEL", "(auto)"), "specialists": os.environ.get("RADAR_SPEC_MODEL", "(auto)")},
        "field_uploads_enabled": bool(os.environ.get("RADAR_FIELD_TOKEN")),
        "scene_mode": os.environ.get("RADAR_SCENE_MODE", "ack"),
        "layers": {k: os.environ.get(f"RADAR_LAYER_{k.upper()}", "cached") for k in ("costar", "vexcel")},
        "matterport": os.environ.get("RADAR_MATTERPORT", "auto"),
    })


app = Starlette(
    routes=[
        Route("/field/scan", post_scan, methods=["POST"]),
        Route("/field/scans/{property_id}", get_scans, methods=["GET"]),
        Route("/healthz", healthz, methods=["GET"]),
    ]
)

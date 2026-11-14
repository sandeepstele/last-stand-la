"""HTTP routes mounted on the Agent Server through langgraph.json "http.app" (works the same
under `langgraph dev --host 0.0.0.0`, port 2024).

POST /field/scan              Radar Field iOS upload; header X-Radar-Token must match RADAR_FIELD_TOKEN
GET  /field/scans/{property}  stored scans for a property (same token)
GET  /healthz                 configuration check (no secrets)
GET  /cases/queue             the overnight case queue: counts by case type and the top cases by stakes
POST /cases/decision          a person approves or rejects a DRAFT correction {property_id, case, decision, draft}
GET  /evidence/image/{name}   a cached evidence image from fixtures/vision (file name only)
GET  /cases/inbox             the newest inbox items (case of the day, notifications) and recorded decisions

Uploads are refused when RADAR_FIELD_TOKEN is unset. Custom routes skip the server's own auth,
so the token is the only gate. Handlers do no blocking I/O on the event loop (langgraph dev's
blockbuster rejects it): the Store is async and fixture reads go through asyncio.to_thread.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import re
import uuid
from datetime import UTC, datetime
from functools import lru_cache

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
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
        "models": {"orchestrator": os.environ.get("RADAR_ORCH_MODEL", "(auto)"),
                   "specialists": os.environ.get("RADAR_FAST_MODEL", "(auto)"),
                   "timeout_s": os.environ.get("RADAR_MODEL_TIMEOUT_S", "8")},
        "field_uploads_enabled": bool(os.environ.get("RADAR_FIELD_TOKEN")),
        "scene_mode": os.environ.get("RADAR_SCENE_MODE", "ack"),
        "layers": {k: os.environ.get(f"RADAR_LAYER_{k.upper()}", "cached") for k in ("costar", "vexcel")},
        "matterport": os.environ.get("RADAR_MATTERPORT", "auto"),
        "replay": _replay_label(),
    })


def _replay_label() -> str | None:
    from app import replay

    m = replay.mode()
    return None if m is None else (f"recording {m[1]}" if m[0] == "record" else m[1])


# ------------------------------------------------------------------ case queue and evidence


def _queue() -> dict:
    from app import cases

    return cases.queue()


async def cases_queue(request: Request) -> JSONResponse:
    return JSONResponse(await asyncio.to_thread(_queue))


async def cases_decision(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return JSONResponse({"error": "bad json"}, status_code=400)
    decision = body.get("decision")
    pid = str(body.get("property_id") or "")
    if decision not in ("approve", "reject") or not layers.PROPERTY_ID.match(pid):
        return JSONResponse({"error": "decision must be approve or reject, with a valid property_id"}, status_code=400)
    record = {"property_id": pid, "suite": str(body.get("suite") or "")[:20] or None, "case": str(body.get("case") or "")[:40], "decision": decision,
              "draft": str(body.get("draft") or "")[:2000], "at": datetime.now(UTC).isoformat(),
              "note": "recorded only: nothing is sent to CoStar or the city"}
    await _store(request).aput(("corrections",), uuid.uuid4().hex, record)
    return JSONResponse({"status": "recorded", **record})


async def cases_inbox(request: Request) -> JSONResponse:
    store = _store(request)
    out = await store.asearch(("outbox",), limit=50)
    dec = await store.asearch(("corrections",), limit=50)
    items = sorted(({"kind": i.value.get("kind"), "text": i.value.get("text"), "at": i.value.get("at")} for i in out),
                   key=lambda x: x["at"] or "", reverse=True)[:5]
    decisions = sorted(({k: i.value.get(k) for k in ("property_id", "suite", "case", "decision", "at", "via")} for i in dec),
                       key=lambda x: x["at"] or "", reverse=True)[:5]
    return JSONResponse({"inbox": items, "decisions": decisions})


IMAGE_NAME = re.compile(r"^[A-Za-z0-9_.-]{1,120}\.jpg$")


async def evidence_image(request: Request) -> Response:
    from app import vision

    name = request.path_params["name"]
    path = vision.CACHE / name
    if not IMAGE_NAME.match(name) or ".." in name or not await asyncio.to_thread(path.is_file):
        return JSONResponse({"error": "not found"}, status_code=404)
    data = await asyncio.to_thread(path.read_bytes)
    return Response(data, media_type="image/jpeg", headers={"cache-control": "private, max-age=3600"})


app = Starlette(
    routes=[
        Route("/cases/queue", cases_queue, methods=["GET"]),
        Route("/cases/decision", cases_decision, methods=["POST"]),
        Route("/cases/inbox", cases_inbox, methods=["GET"]),
        Route("/evidence/image/{name}", evidence_image, methods=["GET"]),
        Route("/field/scan", post_scan, methods=["POST"]),
        Route("/field/scans/{property_id}", get_scans, methods=["GET"]),
        Route("/healthz", healthz, methods=["GET"]),
    ]
)

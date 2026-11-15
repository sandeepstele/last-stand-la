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
        "layers": {k: os.environ.get(f"RADAR_LAYER_{k.upper()}", "auto") for k in ("costar", "vexcel")},  # layers._mode's default
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
    out = await store.asearch(("outbox",), limit=1000)
    dec = await store.asearch(("corrections",), limit=1000)
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


# ------------------------------------------------------------------ Last Stand LA (app/fortress.py)

PID = re.compile(r"^[0-9]{1,12}$")


async def game_district(request: Request) -> JSONResponse:
    from app import fortress

    return JSONResponse(await asyncio.to_thread(fortress.district))


async def game_city(request: Request) -> JSONResponse:
    from app import fortress

    return JSONResponse(await asyncio.to_thread(fortress.city))


MESH_DIR = __import__("pathlib").Path(__file__).resolve().parent.parent / "fixtures" / "matterport" / "mesh"


async def game_mesh(request: Request) -> Response:
    # GET /game/mesh/{pid}: the interior shell (Matterport 50k OBJ, untextured, z up, same frame as the scan spots).
    # Licensed and gitignored; served to the local game only.
    from app import costar

    pid = request.path_params["pid"]
    if not PID.match(pid):
        return JSONResponse({"error": "bad id"}, status_code=404)
    from app import vision

    def hop_model() -> str | None:  # the walk's own model (e.g. a suite tour) wins over the building's twin
        f = vision.CACHE / f"feed_{pid}_hops.json"
        try:
            return next((h.get("model") for h in json.loads(f.read_text()) if h.get("model")), None) if f.is_file() else None
        except ValueError:
            return None
    m = await asyncio.to_thread(hop_model)
    models = [m] if m else (await asyncio.to_thread(costar.get, pid)).get("matterport_model_ids") or []
    path = MESH_DIR / f"{models[0]}_50k.obj" if models else None
    if not path or not await asyncio.to_thread(path.is_file):
        return JSONResponse({"error": "no interior mesh cached"}, status_code=404)
    data = await asyncio.to_thread(path.read_bytes)
    return Response(data, media_type="text/plain", headers={"cache-control": "private, max-age=3600"})


async def game_stale(request: Request) -> JSONResponse:
    from app import fortress

    return JSONResponse(await asyncio.to_thread(fortress.stale))


async def game_solar(request: Request) -> JSONResponse:
    from app import fortress

    return JSONResponse(await asyncio.to_thread(fortress.solar))


async def game_suites(request: Request) -> JSONResponse:
    from app import fortress

    pid = request.path_params["pid"]
    if not PID.match(pid) or not await asyncio.to_thread(fortress.building, pid):
        return JSONResponse({"error": "not a building in the district"}, status_code=404)
    return JSONResponse(await asyncio.to_thread(fortress.suites, pid))


async def game_dossier(request: Request) -> JSONResponse:
    from app import fortress

    from app import evidence

    pid = request.path_params["pid"]
    if not PID.match(pid) or not await asyncio.to_thread(fortress.building, pid):
        return JSONResponse({"error": "not a building in the district"}, status_code=404)
    # display-only feed photos (HTTP only); with_feeds globs the image cache, so it runs off the event loop too
    d = await asyncio.to_thread(lambda: fortress.with_feeds(fortress.dossier(pid)))
    raw = request.query_params.get("checks")
    if raw is not None:
        # ?checks=a,b: walls re-weighed with the evidence so far plus any player report (same as commit_plan), so the
        # fortress card matches the case file. Unknown check names are ignored.
        checks = [c for c in dict.fromkeys(x.strip() for x in raw.split(",")) if c in evidence.CHECK_WHAT and c != "human_report"]
        notes = [i.value for i in await _store(request).asearch(("notes", pid), limit=10)]
        if notes:
            checks.append("human_report")
        w = await asyncio.to_thread(fortress.walls, pid, checks, notes)
        d["scores"]["walls"] = {k: w[k] for k in ("value", "label", "why", "source")}
    return JSONResponse(d)


async def game_resolve(request: Request) -> JSONResponse:
    """The fallback path when the agent is down: same code, same seeded rolls as commit_plan."""
    from app import fortress

    try:
        body = json.loads(await request.body())
        pid, wave = str(body["pid"]), int(body.get("wave") or 1)
        seed = int(body.get("seed") or fortress.SEED)
        action = "run" if body.get("action") == "run" else "hold"
        to_pid = str(body["to_pid"]) if body.get("to_pid") else None
        checks = [str(c) for c in (body.get("checks") or [])][:12]
    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
        return JSONResponse({"error": "expected {pid, wave, seed, action, to_pid?, checks?}"}, status_code=400)
    for p in (pid, to_pid):
        if p is not None and (not PID.match(p) or not await asyncio.to_thread(fortress.building, p)):
            return JSONResponse({"error": f"{p} is not a building in the district"}, status_code=404)
    items = await _store(request).asearch(("notes", pid), limit=10)
    notes = [i.value for i in items]
    if notes and "human_report" not in checks:
        checks.append("human_report")
    return JSONResponse(await asyncio.to_thread(fortress.resolve, pid, wave, seed, action, to_pid, checks, notes))


async def demo_reset(request: Request) -> JSONResponse:
    # POST /demo/reset with JSON body confirm=reset: the one-click "Play again" at the table. Clears what one night
    # leaves in the Store (team notes and player reports, correction decisions, outbox drafts) so the next night starts
    # clean and its strict-replay keys match. Local callers only; the JSON body keeps a cross-site page from triggering
    # it. scripts/demo_reset.py does the same from a terminal (and also deletes paused threads). (A comment, not a
    # docstring: the server parses route docstrings as YAML for its schema.)
    host = request.client.host if request.client else ""
    if host not in ("127.0.0.1", "::1", "localhost", "testclient"):
        return JSONResponse({"error": "local only"}, status_code=403)
    try:
        body = json.loads(await request.body() or b"{}")
    except json.JSONDecodeError:
        body = {}
    if body.get("confirm") != "reset":
        return JSONResponse({"error": 'send {"confirm": "reset"}'}, status_code=400)
    store, cleared = _store(request), {}
    for prefix in (("notes",), ("corrections",), ("outbox",), ("laststand_cases",), ("laststand_log",)):
        n = 0
        while items := await store.asearch(prefix, limit=100):
            for it in items:
                await store.adelete(it.namespace, it.key)
                n += 1
        cleared["/".join(prefix)] = n
    from deepagents.backends.utils import create_file_data

    from app.night_log import LAST_STAND_LOG_SEED

    # every night starts from the same fixed "previous night", so the briefing reads the recorded memory
    await store.aput(("laststand_log",), "/latest.md", create_file_data(LAST_STAND_LOG_SEED))
    # the auditor's standing orders and skills (scripts/seed_store.py), if this server's Store doesn't have them yet:
    # the bridge's recorded replay depends on them
    seed = __import__("pathlib").Path(__file__).resolve().parent.parent / "seed"

    def seed_files() -> list:  # file listing and reads off the event loop (langgraph dev rejects blocking I/O there)
        paths = [(("memories",), "/AGENTS.md", seed / "memories" / "AGENTS.md")] + \
            [(("skills",), f"/{d.name}/SKILL.md", d / "SKILL.md") for d in sorted((seed / "skills").glob("*"))]
        return [(ns, key, p.read_text()) for ns, key, p in paths if p.is_file()]
    seeded = 0
    for ns, key, text in await asyncio.to_thread(seed_files):
        if not await store.aget(ns, key):
            await store.aput(ns, key, create_file_data(text))
            seeded += 1
    return JSONResponse({"ok": True, "cleared": cleared, "night_log": "seeded", "auditor_seed_files_added": seeded})


app = Starlette(
    routes=[
        Route("/demo/reset", demo_reset, methods=["POST"]),
        Route("/game/district", game_district, methods=["GET"]),
        Route("/game/city", game_city, methods=["GET"]),
        Route("/game/suites/{pid}", game_suites, methods=["GET"]),
        Route("/game/solar", game_solar, methods=["GET"]),
        Route("/game/stale", game_stale, methods=["GET"]),
        Route("/game/mesh/{pid}", game_mesh, methods=["GET"]),
        Route("/game/dossier/{pid}", game_dossier, methods=["GET"]),
        Route("/game/resolve", game_resolve, methods=["POST"]),
        Route("/cases/queue", cases_queue, methods=["GET"]),
        Route("/cases/decision", cases_decision, methods=["POST"]),
        Route("/cases/inbox", cases_inbox, methods=["GET"]),
        Route("/evidence/image/{name}", evidence_image, methods=["GET"]),
        Route("/field/scan", post_scan, methods=["POST"]),
        Route("/field/scans/{property_id}", get_scans, methods=["GET"]),
        Route("/healthz", healthz, methods=["GET"]),
    ]
)

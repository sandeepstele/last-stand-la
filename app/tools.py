"""Tools the agent sees. Thin wrappers around the pure modules. Numbers always come from
the data layers by property id (app/layers.py), never from values the model typed.

Status of each seam:
  data layers  CACHED fixtures with provenance; live CoStar/Vexcel toolkit is spike S2
  matterport   REAL read-only Model API client, live/cached
  verifier     REAL (app/verify.py)
  field check  REAL (app/field.py, Store-backed)
  queue        REAL (Store namespace "queue")
  scene        app/scene.py (live graph only)
  photon       app/photon.py; not configured until PHOTON_* keys exist (then outbound only)

Any exception a tool raises is turned into a message by ToolErrorMiddleware (app/agent.py),
so a missing fixture or a Wi-Fi drop can't abort a run.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import asdict
from datetime import UTC, datetime
from typing import Any

from langchain.tools import ToolRuntime, tool

from app import field, layers, photon
from app.verify import investigate, retrofit_math

FIELD_REQUEST = (
    "Field check: open Radar Field on a LiDAR iPhone, start in a room at the entrance level, scan one "
    "typical-floor room, and look for stairs going down (toggle 'checked for stairs' only if you did)."
)


def _now() -> str:
    return datetime.now(UTC).isoformat()


# ------------------------------------------------------------------ data layers (specialists)


@tool
def costar_record(property_id: str) -> dict:
    """CoStar building record: rba_sqft, stories, building_type, land_area_sqft, building_count,
    year_built, year_renovated, owner, tenants, lease_expirations, plus source and synthetic flags."""
    return layers.get_record(property_id)


@tool
def vexcel_attributes(property_id: str) -> dict:
    """Vexcel building attributes: footprint_sqft, height_m, roof_condition, roof objects and their
    area, setback_detected, capture date, plus source and synthetic flags."""
    return layers.get_aerial(property_id)


@tool
def twin_levels(property_id: str) -> dict:
    """The building's Matterport twin: levels with median scan elevation and scanned extent, the
    entrance level, levels below it, mezzanines, floor-to-floor height and coverage of the footprint."""
    b = layers.load_building(property_id)
    if b.twin is None:
        return {"property_id": b.property_id, "twin": None, "warnings": b.warnings}
    out = asdict(b.twin)
    out.update(matterport_model_id=b.twin_id, coverage_of_footprint=round(b.twin.coverage(b.aerial.footprint_sqft), 2),
               provenance=b.provenance.get("matterport"))
    return out


# ------------------------------------------------------------------ verifier


@tool
async def verify_building(property_id: str, runtime: ToolRuntime) -> dict:
    """Load the building's CoStar record, Vexcel attributes, Matterport twin and latest field check,
    reconcile listed area with footprint x stories, and test every explanation for a gap.
    Returns the verdict, confidence, evidence, next_checks, provenance and assumption status."""
    b = await asyncio.to_thread(layers.load_building, property_id)
    scan = await field.latest_scan(runtime.store, b.property_id)  # never a stand-in
    inv = investigate(b.records, b.aerial, b.twin, scan)
    out = inv.to_dict()
    out["property_id"] = b.property_id
    out["provenance"] = b.provenance
    out["synthetic_data"] = b.synthetic
    out["warnings"] = b.warnings + inv.warnings
    out["next_checks"] = [
        {"hypothesis": h.title, "ask": h.tester} for h in inv.hypotheses if h.status == "untested" and h.key != "stale_record"
    ]
    inside_open = any(h.status == "untested" and h.key in ("below_grade", "mezzanine", "floor_count") for h in inv.hypotheses)
    if inv.verdict == "worth_a_look" and inside_open:
        out["field_check_request"] = FIELD_REQUEST
    preview_scan = await field.latest_scan(runtime.store, b.property_id, include_stand_in=True)
    if preview_scan is not None:
        out["field_check"] = field.preview(preview_scan, b.aerial.height_m, b.records.stories)
    return out


@tool
async def retrofit(property_id: str, city: str, runtime: ToolRuntime) -> dict:
    """Size solar on usable roof only and return kWh/yr, % of building load, t CO2/yr, whether to
    re-roof first, and which inputs are still placeholders. city: houston or los_angeles."""
    b = await asyncio.to_thread(layers.load_building, property_id)
    scan = await field.latest_scan(runtime.store, b.property_id)
    inv = investigate(b.records, b.aerial, b.twin, scan)
    area = inv.trusted_area_sqft or b.records.rba_sqft
    out = asdict(retrofit_math(b.records, b.aerial, area, city))
    out["area_basis"] = "listed area, explained by the verifier" if inv.trusted_area_sqft else "listed area, NOT verified"
    out["synthetic_data"] = b.synthetic
    return out


@tool
async def field_check(property_id: str, runtime: ToolRuntime) -> dict:
    """Latest iPhone LiDAR field check for a building (Radar Field app): ceiling height, interior
    area, any lower level, and whether it is a stand-in (preview only). Ceiling height only caps how
    many floors fit; it is never a floor-to-floor height."""
    pid = layers.check_property_id(property_id)
    scan = await field.latest_scan(runtime.store, pid, include_stand_in=True)
    if scan is None:
        return {"property_id": pid, "field_check": None, "request": FIELD_REQUEST}
    try:
        b = await asyncio.to_thread(layers.load_building, pid)
        height, stories = b.aerial.height_m, b.records.stories
    except layers.LayerError:
        height = stories = None
    return {**scan.to_dict(), "summary": field.preview(scan, height, stories)}


# ------------------------------------------------------------------ worker queue (Store "queue")


@tool
async def queue_next(runtime: ToolRuntime, limit: int = 3) -> list[dict]:
    """Up to `limit` queued buildings for this tick, oldest first."""
    items = await runtime.store.asearch(("queue",), limit=200)
    queued = sorted((i for i in items if i.value.get("status") == "queued"), key=lambda i: i.value.get("added_at", ""))
    return [{"property_id": i.key, **i.value} for i in queued[: max(1, min(limit, 5))]]


@tool
async def queue_done(property_id: str, outcome: str, runtime: ToolRuntime) -> str:
    """Mark a queued building as screened, with a one-line outcome."""
    pid = layers.check_property_id(property_id)
    item = await runtime.store.aget(("queue",), pid)
    value = dict(item.value) if item else {"task": "screen", "added_at": _now()}
    value.update(status="done", outcome=outcome[:300], done_at=_now())
    await runtime.store.aput(("queue",), pid, value)
    return f"{pid} marked done."


@tool
async def watch_building(property_id: str, reason: str, runtime: ToolRuntime) -> str:
    """Add a building to the background worker's queue. Requires the user's approval."""
    pid = layers.check_property_id(property_id)
    await runtime.store.aput(("queue",), pid, {"task": "screen", "reason": reason[:300], "status": "queued",
                                               "added_by": "agent", "added_at": _now()})
    return f"{pid} added to the queue."


# ------------------------------------------------------------------ side effects


async def _outbox(runtime: ToolRuntime, kind: str, payload: dict[str, Any], delivery: dict[str, Any]) -> None:
    if runtime.store is not None:
        await runtime.store.aput(("outbox",), uuid.uuid4().hex, {"kind": kind, **payload, "delivery": delivery, "at": _now()})


@tool
async def notify_me(text: str, runtime: ToolRuntime) -> str:
    """Text the user (their own number) a short finding. Not gated."""
    delivery = await photon.send(text[:600])
    await _outbox(runtime, "notify_me", {"text": text[:600]}, delivery)
    if delivery["status"] == "not_configured":
        return "Saved to the in-app inbox (texting is not configured)."
    return f"Text {delivery['status']} (202 means accepted, not yet delivered)."


@tool
async def send_outreach(to: str, text: str, runtime: ToolRuntime) -> str:
    """Message someone other than the user. Always requires the user's approval."""
    await _outbox(runtime, "send_outreach", {"to": to[:120], "text": text[:600]}, {"status": "recorded"})
    return "Recorded in the outbox (outbound to third parties is not wired)."


SIDE_EFFECT_TOOLS = [notify_me, send_outreach, watch_building]
QUEUE_TOOLS = [queue_next, queue_done]

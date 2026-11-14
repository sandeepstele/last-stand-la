"""Scene verbs for the live graph: the agent drives the 3D world pane through typed actions,
and the frontend confirms each one (Ayana's runtime contract).

Contract (contracts/frontend_action.schema.json, contracts/ack.schema.json):
  1. stage() emits a custom stream event {"type": "frontend_action", "id", "verb", "args"}.
  2. The web app performs it, screenshots the canvas, POSTs {id, ok, screenshot_jpeg_b64?} to
     /api/ack, which writes Store ("acks",) key=id.
  3. stage() polls the Store up to RADAR_ACK_TIMEOUT_S, then gives up.

Every verb takes only a property id (plus city for solar): the numbers come from the data
layers and the verifier, never from the model. After one timeout in a thread the scene drops to
"dispatch" mode (send, don't wait) so a dead screen can't stall the demo. Tool results stay
neutral; the agent never narrates what the screen shows.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from dataclasses import asdict
from typing import Any

from langchain.tools import ToolRuntime, tool

from app import layers
from app.verify import investigate, retrofit_math

ACK_POLL_S = 0.15


def _timeout() -> float:
    return float(os.environ.get("RADAR_ACK_TIMEOUT_S", "6"))


def _mode() -> str:
    return os.environ.get("RADAR_SCENE_MODE", "ack").strip().lower()  # ack | dispatch


def _thread(runtime: ToolRuntime) -> str:
    return str(((runtime.config or {}).get("configurable") or {}).get("thread_id", "local"))


async def stage(verb: str, args: dict[str, Any], runtime: ToolRuntime) -> str | list:
    action_id = uuid.uuid4().hex
    runtime.stream_writer({"type": "frontend_action", "id": action_id, "verb": verb, "args": args})
    store = runtime.store
    if _mode() == "dispatch" or store is None:
        return f"{verb}: sent to the screen."
    if await store.aget(("scene",), _thread(runtime)) is not None:
        return f"{verb}: sent to the screen (confirmations off after an earlier timeout)."
    for _ in range(max(1, int(_timeout() / ACK_POLL_S))):
        item = await store.aget(("acks",), action_id)
        if item:
            ack = item.value
            if not ack.get("ok"):
                return f"{verb}: the screen reported it could not show this."
            blocks: list = [{"type": "text", "text": f"{verb}: confirmed on screen."}]
            if ack.get("screenshot_jpeg_b64"):
                blocks.append({"type": "image", "base64": ack["screenshot_jpeg_b64"], "mime_type": "image/jpeg"})
            return blocks
        await asyncio.sleep(ACK_POLL_S)
    await store.aput(("scene",), _thread(runtime), {"degraded": True})
    return f"{verb}: sent to the screen (no confirmation)."


def _building(property_id: str) -> layers.Building:
    return layers.load_building(property_id)


@tool
async def show_building(property_id: str, runtime: ToolRuntime) -> str | list:
    """Fly the world pane to the building and extrude its measured footprint and height."""
    b = await asyncio.to_thread(_building, property_id)
    args = {
        "property_id": b.property_id,
        "footprint_sqft": b.aerial.footprint_sqft,
        "height_m": b.aerial.height_m,
        "stories": b.records.stories,
        "polygon_m": b.aerial_raw.get("footprint_polygon_m"),  # optional local-meters outline
        "synthetic": b.synthetic,
    }
    return await stage("show_building", args, runtime)


@tool
async def ghost_compare(property_id: str, runtime: ToolRuntime) -> str | list:
    """Overlay a translucent 'as listed' volume on the 'as measured' volume."""
    b = await asyncio.to_thread(_building, property_id)
    inv = investigate(b.records, b.aerial, b.twin)
    args = {
        "property_id": b.property_id,
        "listed_sqft": b.records.rba_sqft,
        "expected_low_sqft": inv.initial.expected_low_sqft,
        "expected_high_sqft": inv.initial.expected_high_sqft,
        "footprint_sqft": b.aerial.footprint_sqft,
        "height_m": b.aerial.height_m,
        "stories": b.records.stories,
    }
    return await stage("ghost_compare", args, runtime)


@tool
async def reveal_levels(property_id: str, runtime: ToolRuntime) -> str | list:
    """Extrude the twin's levels below the entrance under the massing model."""
    b = await asyncio.to_thread(_building, property_id)
    below = b.twin.levels_below_entrance if b.twin else []
    args = {
        "property_id": b.property_id,
        "levels": [{"label": lv.label, "offset_m": lv.median_z_m} for lv in below],
        "floor_to_floor_m": b.twin.typical_floor_to_floor_m if b.twin else None,
    }
    return await stage("reveal_levels", args, runtime)


@tool
async def place_solar(property_id: str, city: str, runtime: ToolRuntime) -> str | list:
    """Lay the solar array on usable roof only (layout illustrative)."""
    b = await asyncio.to_thread(_building, property_id)
    r = retrofit_math(b.records, b.aerial, b.records.rba_sqft, city)
    args = {"property_id": b.property_id, **{k: v for k, v in asdict(r).items() if k in ("usable_roof_sqft", "panels", "system_kw")}}
    return await stage("place_solar", args, runtime)


SCENE_TOOLS = [show_building, ghost_compare, reveal_levels, place_solar]

"""Scene verbs for the live graph: the agent drives the 3D world pane through typed actions,
and the frontend confirms each one (Ayana's runtime contract).

Contract (contracts/frontend_action.schema.json, contracts/ack.schema.json):
  1. stage() emits a custom stream event {"type": "frontend_action", "id", "verb", "args"}.
  2. The web app performs it, screenshots the canvas, POSTs {id, ok, screenshot_jpeg_b64?} to
     /api/ack, which writes Store ("acks",) key=id.
  3. stage() polls the Store up to RADAR_ACK_TIMEOUT_S, then gives up.

Every verb takes only a property id: the numbers come from the data
layers and the verifier, never from the model. After one timeout in a thread the scene drops to
"dispatch" mode (send, don't wait) so a dead screen can't stall the demo. Tool results stay
neutral; the agent never narrates what the screen shows.

Order: the agent may call several verbs in one model turn, and they then run concurrently. Each
verb loads its data in parallel with the others but sends its action only after the verbs ahead of
it in ORDER (from the same turn) have sent theirs, so the screen always builds show_building ->
ghost_compare -> reveal_levels -> place_solar. The browser applies actions in arrival order
(web/src/lib/useSceneActions.ts); show_building clears the scene, so a scrambled turn would erase
the ghost. A verb that draws nothing still waits its turn, and in ack mode nobody waits for an
earlier verb's confirmation, only for its send.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import Awaitable
from typing import Any

from langchain.tools import ToolRuntime, tool

from app import field, layers
from app.verify import investigate

ACK_POLL_S = 0.15
ORDER = ("show_building", "ghost_compare", "reveal_levels", "place_solar")
ORDER_WAIT_S = 20.0  # upper bound on waiting for the verb ahead (e.g. one whose call failed validation)
_sent: dict[str, asyncio.Event] = {}  # tool-call id -> set once that verb has sent its action (or drawn nothing)


def _timeout() -> float:
    return float(os.environ.get("RADAR_ACK_TIMEOUT_S", "6"))


def _mode() -> str:
    return os.environ.get("RADAR_SCENE_MODE", "ack").strip().lower()  # ack | dispatch


def _thread(runtime: ToolRuntime) -> str:
    return str(((runtime.config or {}).get("configurable") or {}).get("thread_id", "local"))


def _neighbours(runtime: ToolRuntime) -> tuple[str | None, bool]:
    """(tool-call id of the scene verb just ahead of this one in its model turn, whether one follows it)."""
    me = getattr(runtime, "tool_call_id", None)
    state = getattr(runtime, "state", None)
    messages = state.get("messages", []) if isinstance(state, dict) and me else []
    for m in reversed(messages):
        calls = getattr(m, "tool_calls", None) or []
        if any(c.get("id") == me for c in calls):
            scene = sorted((c for c in calls if c.get("name") in ORDER), key=lambda c: ORDER.index(c["name"]))
            ids = [c.get("id") for c in scene]
            i = ids.index(me)
            return (ids[i - 1] if i else None), i + 1 < len(ids)
    return None, False


async def _wait_turn(runtime: ToolRuntime) -> None:
    ahead, _ = _neighbours(runtime)
    if ahead is None:
        return
    try:
        await asyncio.wait_for(_sent.setdefault(ahead, asyncio.Event()).wait(), ORDER_WAIT_S)
    except asyncio.TimeoutError:
        pass
    _sent.pop(ahead, None)  # each verb has at most one waiter: the one right behind it


def _mark_sent(runtime: ToolRuntime) -> None:
    me = getattr(runtime, "tool_call_id", None)
    if me and _neighbours(runtime)[1]:
        _sent.setdefault(me, asyncio.Event()).set()


async def _draw(verb: str, runtime: ToolRuntime, build: Awaitable[dict[str, Any] | str]) -> str | list:
    """Build the verb's action (concurrently with the rest of the turn), then send it in ORDER.
    `build` returns the action args, or a status string when there is nothing to draw."""
    try:
        args = await build
    except Exception:
        await _wait_turn(runtime)
        _mark_sent(runtime)
        raise
    await _wait_turn(runtime)
    if isinstance(args, str):
        _mark_sent(runtime)
        return args
    return await stage(verb, args, runtime)


async def stage(verb: str, args: dict[str, Any], runtime: ToolRuntime) -> str | list:
    action_id = uuid.uuid4().hex
    runtime.stream_writer({"type": "frontend_action", "id": action_id, "verb": verb, "args": args})
    _mark_sent(runtime)  # the next verb of this turn may go out now; acks are awaited concurrently
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

    async def build():
        b = await asyncio.to_thread(_building, property_id)
        return {
            "property_id": b.property_id,
            "footprint_sqft": b.aerial.footprint_sqft,
            "height_m": b.aerial.height_m,
            "stories": b.records.stories,
            "polygon_m": b.aerial_raw.get("footprint_polygon_m"),  # optional local-meters outline
            "synthetic": b.synthetic,
        }

    return await _draw("show_building", runtime, build())


@tool
async def ghost_compare(property_id: str, runtime: ToolRuntime) -> str | list:
    """Overlay a translucent 'as listed' volume on the 'as measured' volume."""

    async def build():
        b = await asyncio.to_thread(_building, property_id)
        if b.link_problem:
            return "ghost_compare: nothing drawn (the aerial structure is not this building)."
        inv = investigate(b.records, b.aerial, b.twin)
        return {
            "property_id": b.property_id,
            "listed_sqft": b.records.rba_sqft,
            "area_basis": b.records.area_basis,
            "expected_low_sqft": inv.initial.expected_low_sqft,
            "expected_high_sqft": inv.initial.expected_high_sqft,
            "footprint_sqft": b.aerial.footprint_sqft,
            "height_m": b.aerial.height_m,
            "stories": b.records.stories,
        }

    return await _draw("ghost_compare", runtime, build())


@tool
async def reveal_levels(property_id: str, runtime: ToolRuntime) -> str | list:
    """Extrude the twin's levels below the entrance under the massing model. Draws only when the verifier
    counts those levels (below-grade supported by the twin), so it is safe to call alongside verify_building."""

    async def build():
        b = await asyncio.to_thread(_building, property_id)
        if b.link_problem:
            return "reveal_levels: nothing drawn (the aerial structure is not this building)."
        scan = await field.latest_scan(runtime.store, b.property_id)  # the same inputs verify_building uses
        inv = investigate(b.records, b.aerial, b.twin, scan)
        below_grade = next(h for h in inv.hypotheses if h.key == "below_grade")
        below = b.twin.levels_below_entrance if b.twin else []
        if below_grade.status != "supported" or below_grade.tester != "interior" or not below:
            return "reveal_levels: nothing drawn (the twin shows no counted levels below the entrance)."
        return {
            "property_id": b.property_id,
            "levels": [{"label": lv.label, "offset_m": lv.median_z_m} for lv in below],
            "floor_to_floor_m": b.twin.typical_floor_to_floor_m,
        }

    return await _draw("reveal_levels", runtime, build())


@tool
async def place_solar(property_id: str, runtime: ToolRuntime) -> str | list:
    """Lay the solar array on usable roof only, inside the fire-code setback (layout illustrative;
    the sizing is the same screen retrofit returns)."""

    async def build():
        b = await asyncio.to_thread(_building, property_id)
        s = await asyncio.to_thread(layers.screen_solar, b)
        if s.status != "screened":
            return f"place_solar: nothing drawn ({s.status})."
        return {"property_id": b.property_id, "usable_roof_sqft": s.usable_roof_sqft, "panels": s.panels,
                "system_kw": s.system_kw, "load_matched_kw": s.load_matched_kw, "setback_ft": s.roof_breakdown.get("setback_ft")}

    return await _draw("place_solar", runtime, build())


SCENE_TOOLS = [show_building, ghost_compare, reveal_levels, place_solar]

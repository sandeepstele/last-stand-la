"""Tools the agent sees. Thin wrappers around the pure modules. Numbers always come from
the data layers by property id (app/layers.py), never from values the model typed.

Status of each seam:
  data layers  REAL: CoStar data kit + live Vexcel (cached after the first fetch); synthetic TEST-* fixtures
  matterport   REAL read-only Model API client, live/cached
  verifier     REAL (app/verify.py)
  solar        REAL (app/solar.py): Vexcel roof, NREL PVWatts, EIA CBECS load, EPA eGRID, CoStar leases
  field check  REAL (app/field.py, Store-backed)
  queue        REAL (Store namespace "queue")
  scene        app/scene.py (live graph only)
  photon       app/photon.py -> the iMessage bridge in photon/ (Photon Spectrum); inbox-only until
               PHOTON_BRIDGE_TOKEN is set and the bridge runs

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

from app import evidence, field, layers, photon, quake, retrofit_lists, search
from app.verify import investigate

FIELD_REQUEST = (
    "Field check: open Radar Field on a LiDAR iPhone, start in a room at the entrance level, scan one "
    "typical-floor room, and look for stairs going down (toggle 'checked for stairs' only if you did)."
)


def _now() -> str:
    return datetime.now(UTC).isoformat()


# ------------------------------------------------------------------ search (questions without a property id)


@tool
def find_buildings(city: str | None = None, property_type: str | None = None, readiness: str | None = None,
                   deal_fit: str | None = None, min_kw: float | None = None, sort: str = "priority",
                   limit: int = 5) -> dict:
    """Search last night's solar screen of every non-apartment CoStar building (Houston and Los Angeles).
    Use it when the question names no property id. Filters (all optional): city ("houston", "los angeles");
    property_type (office, industrial or warehouse, retail, flex, hotel, healthcare); readiness (ready,
    inspect, reroof_first, unknown); deal_fit (strong, moderate, weak, unknown, or "workable" = strong or
    moderate); min_kw. "Could we sign now" means readiness="ready" and deal_fit="workable".
    sort: priority (default), system_kw, annual_kwh or co2. limit: up to 10.
    Returns matched (how many of the screened buildings match) and the top results with property_id,
    address, kW, MWh/yr, t CO2/yr and the readiness and deal reasons."""
    return search.find(city=city, property_type=property_type, readiness=readiness, deal_fit=deal_fit,
                       min_kw=min_kw, sort=sort, limit=limit)


# ------------------------------------------------------------------ seismic lens (LA retrofit orders)

RETROFIT_FILTERS = {
    "unfinished": lambda a: a["status"] == "unfinished" and not _has(a, "stale_entry"),
    "past_due": lambda a: any(h.get("past_due") for h in a["hypotheses"]),
    "material_conflict": lambda a: _has(a, "material_conflict"),
    "not_proven_safe": lambda a: _has(a, "not_proven_safe"),
    "stale_entry": lambda a: _has(a, "stale_entry"),
    "work_underway": lambda a: _has(a, "work_underway"),
    "any": lambda a: True,
}


def _has(a: dict, key: str) -> bool:
    return any(h["key"] == key for h in a["hypotheses"])


@tool
def seismic_status(property_id: str) -> dict:
    """Los Angeles mandatory seismic retrofit status for one building, from the city's own lists and permits:
    which list (soft-story or non-ductile concrete), the order date, each ordinance step with its deadline
    (including city extensions) and whether it is done, overdue or not due yet, recent retrofit permits,
    CoStar's recorded material and year built, and the hypotheses the code found: unfinished (past_due true
    or false), stale_entry, material_conflict, not_proven_safe, work_underway."""
    return retrofit_lists.status(property_id)


@tool
def find_retrofit_targets(finding: str = "unfinished", retrofit_list: str = "any", limit: int = 8) -> dict:
    """Search every Los Angeles CoStar kit building against the city's seismic retrofit lists, for questions
    that name no building. finding: unfinished (default; excludes stale entries), past_due, material_conflict,
    not_proven_safe, stale_entry, work_underway or any. retrofit_list: soft_story, concrete or any.
    Returns how many match and the top results (past-due first, then most units)."""
    pick = RETROFIT_FILTERS.get((finding or "unfinished").strip().lower())
    if pick is None:
        return {"status": "bad_filter", "allowed": sorted(RETROFIT_FILTERS)}
    lst = {"soft_story": "soft_story", "concrete": "non_ductile_concrete", "any": None}.get((retrofit_list or "any").strip().lower(), "?")
    if lst == "?":
        return {"status": "bad_filter", "allowed_lists": ["soft_story", "concrete", "any"]}
    rows = [a for a in retrofit_lists.portfolio() if pick(a) and (lst is None or any(e["list"] == lst for e in a["lists"]))]
    rows.sort(key=lambda a: (not any(h.get("past_due") for h in a["hypotheses"]), -(a["units"] or 0)))
    return {"status": "ok", "matched": len(rows), "finding": finding, "retrofit_list": retrofit_list,
            "results": [{"property_id": a["property_id"], "address": a["address"], "year_built": a["year_built"],
                         "stories": a["stories"], "units": a["units"], "costar_material": a["costar_material"],
                         "lists": [e["list"] for e in a["lists"]], "findings": [h["key"] for h in a["hypotheses"]],
                         "past_due": any(h.get("past_due") for h in a["hypotheses"])} for a in rows[:max(1, min(limit, 15))]],
            "source": "LA DBS retrofit lists + permits (data.lacity.org), matched locally"}


@tool
def quake_replay(event_id: str = "ci3144585", limit: int = 8) -> dict:
    """LABELED REPLAY of a real past earthquake (default: 1994 Northridge, M6.7) against today's portfolio:
    every LA kit building with a seismic finding, with the shaking it would get (USGS ShakeMap intensity, MMI),
    ranked past-due first, then by shaking. Always say it is a replay of the 1994 earthquake, not a live event."""
    return quake.replay(event_id, limit)


def _note_key(property_id: str, suite: str | None) -> str:
    return f"{property_id}#{suite}" if suite else str(property_id)


@tool
async def record_note(property_id: str, note: str, runtime: ToolRuntime, suite: str | None = None) -> str:
    """Save a fact a person told you about a building or suite (e.g. "plans were submitted in October", "the
    tenant is still there, I called them"). It is kept as a team note and shown on later investigations as a
    claim to verify, never as evidence on its own."""
    if runtime.store is None:
        return "No store available; the note was not saved."
    key = _note_key(property_id, suite)
    await runtime.store.aput(("notes", key), uuid.uuid4().hex, {"note": note[:500], "at": _now()[:10]})
    return f"Saved as a team note on {key}; later investigations will show it as a claim to verify."


@tool
async def open_case(property_id: str, runtime: ToolRuntime, suite: str | None = None) -> dict:
    """Open an investigation when the records contradict each other. Without suite: building cases
    (material_conflict: the city's concrete list vs CoStar's material; stale_entry: listed but newer than the
    ordinance), plus ghost_suites = suites CoStar records as occupied that are listed for lease. With suite: the
    ghost_tenant case for that suite. Returns each case's question, hypotheses with priors, the checks you can run,
    and team_notes: facts people told the team earlier (claims to verify, not evidence)."""
    out = await asyncio.to_thread(evidence.open_case, property_id, suite)
    if runtime.store is not None:
        items = await runtime.store.asearch(("notes", _note_key(property_id, suite)), limit=10)
        if items:
            out["team_notes"] = [{"note": i.value["note"], "noted_on": i.value["at"]} for i in items]
    return out


@tool
def check_evidence(property_id: str, case: str, check: str, suite: str | None = None) -> dict:
    """Run one check for an open case and get what it found and how it shifts each hypothesis (+ supports,
    - weakens). Checks: compliance_filings, permit_text, replacement_permits, era_and_height, site_structures
    for building cases; listing_timeline, lease_terms, tenancy_trail, lot_activity, suite_tour for ghost_tenant (pass
    suite). open_case lists which apply. Run the ones most likely to separate the hypotheses, in parallel."""
    return evidence.run_check(property_id, check, case, suite)


@tool
def weigh_case(property_id: str, case: str, checks: list[str], suite: str | None = None) -> dict:
    """Combine the checks you ran into updated confidence for each hypothesis, a verdict (likely / leaning /
    unresolved), the next most useful check, and a DRAFT correction note when warranted (never sent; a person
    must approve it). The arithmetic is done here; report its numbers, don't compute your own."""
    return evidence.weigh_case(property_id, case, checks, suite)


SEISMIC_TOOLS = [seismic_status, find_retrofit_targets, quake_replay]
CASE_TOOLS = [open_case, check_evidence, weigh_case, record_note]


# ------------------------------------------------------------------ data layers (specialists)


@tool
def costar_record(property_id: str) -> dict:
    """CoStar building record: property_type, address, city, gba_sqft (gross), rba_sqft (rentable),
    stories, height_m, year_built, roof_renovation_years, owner_occupied, tenancy_type, building_class,
    matterport_model_id, plus source and synthetic flags."""
    return layers.get_record(property_id)


@tool
def vexcel_attributes(property_id: str) -> dict:
    """Vexcel roof and building attributes at the CoStar coordinates: footprint_sqft, height_m,
    roof_shape, roof_material, roof_condition_score (higher is better), roof_objects counts,
    existing_pv_sqft, roof_tree_cover_pct, capture_date, which structure was chosen and why,
    plus source and synthetic flags."""
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
    if b.link_problem:  # comparing against the wrong structure would invent a gap
        return {"property_id": b.property_id, "verdict": "check_link", "confidence": "high",
                "headline": f"{b.link_problem} Not compared; re-point the aerial at the right structure first.",
                "provenance": b.provenance, "synthetic_data": b.synthetic, "warnings": b.warnings}
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


_SCREEN_KEYS = ("status", "headline", "usable_roof_sqft", "system_kw", "panels", "annual_kwh", "building_load_kwh",
                "load_offset_pct", "load_matched_kw", "co2_t_per_year", "readiness", "readiness_reasons", "deal_fit",
                "deal_reasons", "roof_breakdown", "warnings")


@tool
async def retrofit(property_id: str, runtime: ToolRuntime) -> dict:
    """Screen the roof for solar from real inputs: Vexcel roof outline minus fire-code setbacks, rooftop
    equipment, existing panels and tree shade; NREL PVWatts yield; building electricity use from CoStar
    gross area x EIA CBECS; EPA eGRID CO2. Also roof readiness (ready / inspect / reroof_first from
    Vexcel condition and roof age) and deal fit (ownership, tenancy, lease terms). The city comes from
    the CoStar record. status check_link means the aerial found a different structure: nothing is sized."""
    b = await asyncio.to_thread(layers.load_building, property_id)
    s = await asyncio.to_thread(layers.screen_solar, b)
    out = {k: v for k, v in s.to_dict().items() if k in _SCREEN_KEYS}
    out["property_id"] = b.property_id
    out["placeholders"] = sorted(k for k, v in s.inputs_status.items() if v == "placeholder")
    out["sources"] = s.sources
    if s.status == "screened" and b.link_problem is None:
        scan = await field.latest_scan(runtime.store, b.property_id)
        inv = investigate(b.records, b.aerial, b.twin, scan)
        out["floor_area_check"] = (f"{inv.verdict}: the load estimate uses the listed area"
                                   + ("" if inv.trusted_area_sqft else ", which the verifier has NOT explained"))
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
    if ((getattr(runtime, "config", None) or {}).get("configurable") or {}).get("channel") == "imessage":
        # The run came from a text: the bridge texts its answer back, so don't send a second text.
        await _outbox(runtime, "notify_me", {"text": text[:600]}, {"status": "inbox_only_imessage_run"})
        return "Saved to the in-app inbox; your final answer is what gets texted back."
    delivery = await photon.send(text[:600])
    await _outbox(runtime, "notify_me", {"text": text[:600]}, delivery)
    if delivery["status"] == "sent":
        return "Texted the user (also saved to the in-app inbox)."
    if delivery["status"] == "not_configured":
        return "Saved to the in-app inbox (texting is not configured)."
    if delivery["status"] == "bridge_offline":
        return "Saved to the in-app inbox (the texting bridge is not running)."
    return f"Saved to the in-app inbox; the text failed ({delivery['status']})."


@tool
async def send_outreach(to: str, text: str, runtime: ToolRuntime) -> str:
    """Message someone other than the user. Always requires the user's approval."""
    await _outbox(runtime, "send_outreach", {"to": to[:120], "text": text[:600]}, {"status": "recorded"})
    return "Recorded in the outbox (outbound to third parties is not wired)."


SIDE_EFFECT_TOOLS = [notify_me, send_outreach, watch_building]
QUEUE_TOOLS = [queue_next, queue_done]

"""Two graphs from one builder: `radar` (live, drives the 3D scene) and `radar_worker`
(background heartbeat, no scene). Both share one Store.

Verified against deepagents 0.7.37 / langchain 1.5.0 (see docs/ENGINEERING.md):
- TodoListMiddleware and ToolErrorMiddleware live in langchain.agents.middleware.
- A subagent spec with "tools": [] gets no tools; without "tools" it inherits every main tool.
- An explicit "general-purpose" spec replaces the auto-added one (which would inherit everything).
- CompositeBackend strips the route prefix: Store key for /memories/AGENTS.md is "/AGENTS.md"
  in namespace ("memories",). Seed with scripts/seed_store.py.
"""

from __future__ import annotations

import os

from deepagents import create_deep_agent
from deepagents.backends import CompositeBackend, StateBackend, StoreBackend
from langchain.agents.middleware import TodoListMiddleware, ToolErrorMiddleware
from pydantic import BaseModel

from app import prompts
from app.scene import SCENE_TOOLS
from app.tools import (
    QUEUE_TOOLS,
    SIDE_EFFECT_TOOLS,
    costar_record,
    field_check,
    retrofit,
    twin_levels,
    verify_building,
    vexcel_attributes,
)


def make_model(name: str, thinking: str = "low"):
    """'gemini-*' -> Gemini on Vertex AI with an API key (Gemini 4 needs the global endpoint);
    anything else ('anthropic:claude-opus-5-5', ...) is passed to LangChain as a model string.
    Measured Fri night: gemini-4-argon 87.6 s per turn at default thinking vs 3.2 s at "low"."""
    if not name.startswith("gemini"):
        return name
    if not os.environ.get("GOOGLE_API_KEY"):
        raise RuntimeError(f"{name} needs GOOGLE_API_KEY")
    from langchain_google_genai import ChatGoogleGenerativeAI

    return ChatGoogleGenerativeAI(
        model=name,
        vertexai=True,
        google_api_key=os.environ["GOOGLE_API_KEY"],
        project=os.environ.get("GOOGLE_CLOUD_PROJECT"),
        location=os.environ.get("GOOGLE_CLOUD_LOCATION", "global"),
        thinking_level=thinking,
    )


def _default(kind: str) -> str:
    """Pick models explicitly from whichever key exists, instead of silently assuming one."""
    if os.environ.get("GOOGLE_API_KEY"):
        return "gemini-4-argon" if kind == "orch" else "gemini-3.8-flash"
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic:claude-opus-5-5" if kind == "orch" else "anthropic:claude-sonnet-5-5"
    raise RuntimeError("Set GOOGLE_API_KEY or ANTHROPIC_API_KEY (or RADAR_ORCH_MODEL / RADAR_SPEC_MODEL).")


ORCH_NAME = os.environ.get("RADAR_ORCH_MODEL") or _default("orch")
SPEC_NAME = os.environ.get("RADAR_SPEC_MODEL") or _default("spec")
# The live graph needs predictable latency; the background worker can use a slower, stronger model.
# Measured Fri night: one gemini-4-argon turn took 113 s even at "low" thinking (others 3-25 s).
WORKER_NAME = os.environ.get("RADAR_WORKER_MODEL") or ORCH_NAME
ORCH = make_model(ORCH_NAME, os.environ.get("RADAR_ORCH_THINKING", "low"))
WORKER = make_model(WORKER_NAME, os.environ.get("RADAR_ORCH_THINKING", "low"))
SPEC = make_model(SPEC_NAME, os.environ.get("RADAR_SPEC_THINKING", "low"))


def _tool_error(exc: Exception, request) -> str:
    name = (request.tool_call or {}).get("name", "tool")
    return f"ERROR from {name}: {type(exc).__name__}: {str(exc)[:300]}. Do not guess this data; say it was unavailable."


def _errors() -> ToolErrorMiddleware:
    return ToolErrorMiddleware(on_error=_tool_error)


class RecordsOut(BaseModel):
    property_id: str
    property_type: str | None = None
    address: str | None = None
    gba_sqft: float | None = None
    rba_sqft: float | None = None
    stories: int | None = None
    year_built: int | None = None
    roof_renovation_years: list[int] = []
    owner_occupied: bool | None = None
    tenancy_type: str | None = None
    source: str | None = None
    synthetic: bool | None = None
    notes: str = ""


class AerialOut(BaseModel):
    property_id: str
    footprint_sqft: float | None = None
    height_m: float | None = None
    roof_shape: str | None = None
    roof_material: str | None = None
    roof_condition_score: float | None = None
    roof_objects: dict[str, int] = {}
    existing_pv_sqft: float | None = None
    capture_date: str | None = None
    structure_chosen_by: str | None = None
    source: str | None = None
    synthetic: bool | None = None
    notes: str = ""


class InteriorOut(BaseModel):
    matterport_model_id: str | None = None
    levels_scanned: int | None = None
    levels_below_entrance: int | None = None
    typical_floor_to_floor_m: float | None = None
    coverage_of_footprint: float | None = None
    notes: str = ""


def _specialists() -> list[dict]:
    return [
        {"name": "records", "description": "Pulls the CoStar building record for a property id: type, gross and rentable area, stories, year built, roof renovations, ownership, tenancy.",
         "system_prompt": prompts.RECORDS_PROMPT, "tools": [costar_record], "model": SPEC, "response_format": RecordsOut, "middleware": [_errors()]},
        {"name": "aerial", "description": "Reads Vexcel attributes for a property id: footprint, height, roof shape, material and condition score, rooftop equipment, existing solar.",
         "system_prompt": prompts.AERIAL_PROMPT, "tools": [vexcel_attributes], "model": SPEC, "response_format": AerialOut, "middleware": [_errors()]},
        {"name": "interior", "description": "Reads the Matterport twin for a property id: levels scanned, levels below the entrance, floor-to-floor height, coverage.",
         "system_prompt": prompts.INTERIOR_PROMPT, "tools": [twin_levels], "model": SPEC, "response_format": InteriorOut, "middleware": [_errors()]},
        # Replaces the auto-added general-purpose subagent, which would inherit every main tool
        # (scene verbs, send_outreach) and the approval gates.
        {"name": "general-purpose", "description": "Explains findings in plain language. Has no tools; never use it to fetch data.",
         "system_prompt": prompts.EXPLAINER_PROMPT, "tools": [], "model": SPEC},
    ]


def _backend() -> CompositeBackend:
    def ns(name: str) -> StoreBackend:
        return StoreBackend(namespace=lambda _rt: (name,))

    # Only file-like data is routed through the backend. queue / acks / outbox / field / scene
    # are plain Store namespaces used directly by tools and routes.
    return CompositeBackend(default=StateBackend(), routes={"/memories/": ns("memories"), "/skills/": ns("skills"), "/properties/": ns("properties")})


def build(mode: str, store=None, checkpointer=None):
    """On Agent Server leave store/checkpointer as None (the server provides Postgres).
    For local runs pass an InMemoryStore and InMemorySaver."""
    live = mode == "live"
    tools = [verify_building, retrofit, field_check, *SIDE_EFFECT_TOOLS, *(SCENE_TOOLS if live else QUEUE_TOOLS)]
    return create_deep_agent(
        model=ORCH if live else WORKER,
        tools=tools,
        system_prompt=prompts.LIVE_PROMPT if live else prompts.WORKER_PROMPT,
        middleware=[TodoListMiddleware(system_prompt=prompts.TODO_PROMPT), _errors()],
        subagents=_specialists(),
        skills=["/skills/"],
        memory=["/memories/AGENTS.md"],
        backend=_backend(),
        interrupt_on={
            "send_outreach": {"allowed_decisions": ["approve", "edit", "reject"]},
            "watch_building": {"allowed_decisions": ["approve", "reject"]},
        },
        store=store,
        checkpointer=checkpointer,
        name="radar" if live else "radar_worker",
    )


live_agent = build("live")
worker_agent = build("worker")

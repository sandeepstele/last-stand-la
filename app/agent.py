"""Two graphs from one builder: `radar` (live, drives the 3D scene) and `radar_worker`
(background heartbeat, no scene). Both share one Store.

Verified against deepagents 0.7.37 / langchain 1.5.0 (see docs/ENGINEERING.md):
- TodoListMiddleware and ToolErrorMiddleware live in langchain.agents.middleware.
- A subagent spec with "tools": [] gets no tools; without "tools" it inherits every main tool.
- An explicit "general-purpose" spec replaces the auto-added one (which would inherit everything).
- CompositeBackend strips the route prefix: Store key for /memories/AGENTS.md is "/AGENTS.md"
  in namespace ("memories",). Seed with scripts/seed_store.py.
- ModelFallbackMiddleware catches any exception from a model call (a client timeout included) and
  sends the same request to the next model; a subagent's own middleware list gets one too.
"""

from __future__ import annotations

import os
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from deepagents import create_deep_agent
from deepagents.backends import CompositeBackend, StateBackend, StoreBackend
from langchain.agents.middleware import AgentMiddleware, ModelFallbackMiddleware, TodoListMiddleware, ToolErrorMiddleware
from langchain_core.messages import ToolMessage
from pydantic import BaseModel


_VERTEX_KEY_INIT_LOCK = threading.RLock()


@contextmanager
def _vertex_api_key_only():
    """Initialize Google GenAI in Vertex express mode, without ADC/project env."""
    env_names = ("GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION")
    previous = {name: os.environ.pop(name, None) for name in env_names}
    try:
        yield
    finally:
        for name, value in previous.items():
            if value is not None:
                os.environ[name] = value

from app import prompts
from app.scene import SCENE_TOOLS
from app.tools import (
    CASE_TOOLS,
    QUEUE_TOOLS,
    SEISMIC_TOOLS,
    SIDE_EFFECT_TOOLS,
    costar_record,
    field_check,
    find_buildings,
    retrofit,
    seismic_status,
    twin_levels,
    verify_building,
    vexcel_attributes,
)


def make_model(name: str, thinking: str = "low", timeout: float | None = None, attempts: int | None = None):
    """'gemini-*' -> Gemini on Vertex AI Express Mode with an API key (global endpoint);
    anything else ('anthropic:claude-opus-5-5', ...) is passed to LangChain as a model string.
    `timeout` caps each attempt in seconds; `attempts` counts the first call (google-genai semantics,
    so 1 means no retry). None keeps the library defaults: no time limit, 6 attempts on 408/429/5xx.
    Measured Fri night: gemini-4-argon 87.6 s per turn at default thinking vs 3.2 s at "low"."""
    if not name.startswith("gemini"):
        return name
    if not os.environ.get("GOOGLE_API_KEY"):
        raise RuntimeError(f"{name} needs GOOGLE_API_KEY")
    from langchain_google_genai import ChatGoogleGenerativeAI

    limits = {"timeout": timeout, "max_retries": attempts}
    # langchain-google-genai passes project/location to google-genai even when the API
    # key is set in the environment. google-genai gives those explicit values precedence
    # over the Vertex Express API key, then silently switches to local ADC. Initialize
    # while those two values are absent so the client is permanently key-authenticated;
    # for Express Mode, the key selects the project and the SDK uses the global endpoint.
    with _VERTEX_KEY_INIT_LOCK, _vertex_api_key_only():
        return ChatGoogleGenerativeAI(
            model=name,
            vertexai=True,
            google_api_key=os.environ["GOOGLE_API_KEY"],
            thinking_level=thinking,
            **{k: v for k, v in limits.items() if v},
        )


def _default(kind: str) -> str:
    """Pick models explicitly from whichever key exists, instead of silently assuming one."""
    if os.environ.get("GOOGLE_API_KEY"):
        return {"orch": "gemini-4-argon", "spec": "gemini-3.8-flash", "fast": "gemini-3.5-flash-lite"}[kind]
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic:claude-opus-5-5" if kind == "orch" else "anthropic:claude-sonnet-5-5"
    raise RuntimeError("Set GOOGLE_API_KEY or ANTHROPIC_API_KEY (or RADAR_ORCH_MODEL / RADAR_SPEC_MODEL).")


@dataclass(frozen=True)
class Models:
    orch: Any  # live orchestrator
    orch_fallbacks: tuple  # tried in order when a live orchestrator call fails or times out
    spec: Any  # live specialists
    spec_fallbacks: tuple
    worker: Any  # background worker
    worker_spec: Any  # the worker's specialists


def models() -> Models:
    """The worker can wait, so its models have no time limit (one gemini-4-argon turn took 113 s).

    The live graph can't. Measured Sat 3 am over 94 live calls: Vertex sometimes holds a request
    10-55 s before the first token (19% of calls over 8 s), and a retry on the same model usually
    lands in the same stall. So each live call gets one short attempt (RADAR_MODEL_TIMEOUT_S, default
    8 s; RADAR_MODEL_RETRIES extra same-model tries, default 0), then one on the other fast model, and
    only then a last try with no time limit, so a slow call still ends in an answer, never a crash.
    Live specialists run on RADAR_FAST_MODEL (gemini-3.5-flash-lite at thinking "minimal": p90 1.4 s
    in a 15-call probe, against 3.0 s for gemini-3.8-flash, which rejects "minimal")."""
    orch_name = os.environ.get("RADAR_ORCH_MODEL") or _default("orch")
    spec_name = os.environ.get("RADAR_SPEC_MODEL") or _default("spec")
    fast_name = os.environ.get("RADAR_FAST_MODEL") or _default("fast")
    worker_name = os.environ.get("RADAR_WORKER_MODEL") or orch_name
    orch_thinking = os.environ.get("RADAR_ORCH_THINKING", "low")
    spec_thinking = os.environ.get("RADAR_SPEC_THINKING", "low")
    fast_thinking = os.environ.get("RADAR_FAST_THINKING", "minimal")
    timeout = float(os.environ.get("RADAR_MODEL_TIMEOUT_S", "8")) or None  # 0 = no limit
    attempts = 1 + int(os.environ.get("RADAR_MODEL_RETRIES", "0"))

    def quick(name: str, thinking: str):
        return make_model(name, thinking, timeout=timeout, attempts=attempts)

    fast = quick(fast_name, fast_thinking)
    worker_spec = make_model(spec_name, spec_thinking)
    return Models(
        orch=quick(orch_name, orch_thinking),
        orch_fallbacks=(fast, make_model(orch_name, orch_thinking)),
        spec=fast,
        spec_fallbacks=(quick(spec_name, spec_thinking), worker_spec),
        worker=make_model(worker_name, orch_thinking),
        worker_spec=worker_spec,
    )


def _replayable(m: Models) -> Models:
    """RADAR_REPLAY set: every model records or replays its responses (app/replay.py). Unset: unchanged."""
    from app import replay

    if replay.mode() is None:
        return m
    w = replay.wrap
    return Models(orch=w(m.orch), orch_fallbacks=tuple(w(x) for x in m.orch_fallbacks), spec=w(m.spec),
                  spec_fallbacks=tuple(w(x) for x in m.spec_fallbacks), worker=w(m.worker), worker_spec=w(m.worker_spec))


MODELS = _replayable(models())
LENS = os.environ.get("RADAR_LENS", "seismic").strip().lower()  # seismic (the pitch) or solar (kept, hidden)


def _tool_error(exc: Exception, request) -> str:
    name = (request.tool_call or {}).get("name", "tool")
    return f"ERROR from {name}: {type(exc).__name__}: {str(exc)[:300]}. Do not guess this data; say it was unavailable."


def _errors() -> ToolErrorMiddleware:
    return ToolErrorMiddleware(on_error=_tool_error)


class AnswerAfterFetch(AgentMiddleware):
    """A live specialist calls its one data tool, then must answer: once a tool result is in, the model
    is called with no tools. Measured Sat 3:30 am: gemini-3.5-flash-lite once re-called vexcel_attributes
    191 times (250 s) instead of returning its structured output. Works with either structured-output
    strategy (with ToolStrategy only the response tool is left)."""

    @staticmethod
    def _answer_only(request):
        if any(isinstance(m, ToolMessage) for m in request.messages):
            return request.override(tools=[])
        return request

    def wrap_model_call(self, request, handler):
        return handler(self._answer_only(request))

    async def awrap_model_call(self, request, handler):
        return await handler(self._answer_only(request))


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


class CivicOut(BaseModel):
    property_id: str
    on_retrofit_list: str | None = None  # soft_story / non_ductile_concrete / none
    status: str | None = None  # unfinished / finished / not_listed / not_applicable
    order_date: str | None = None
    overdue_steps: list[str] = []
    next_deadline: str | None = None
    costar_material: str | None = None
    findings: list[str] = []
    recent_permits: int | None = None
    source: str | None = None
    notes: str = ""


def _specialists(live: bool = True, m: Models | None = None) -> list[dict]:
    """Live specialists run on the fast model, fetch once, and get the timeout-and-fallback chain;
    the worker's have no time limit (and are unchanged)."""
    m = m or MODELS
    model = m.spec if live else m.worker_spec

    def middleware(tools: bool = True) -> list:
        if not live:
            return [_errors()] if tools else []
        return ([_errors(), AnswerAfterFetch()] if tools else []) + [ModelFallbackMiddleware(*m.spec_fallbacks)]

    return [
        {"name": "records", "description": "Pulls the CoStar building record for a property id: type, gross and rentable area, stories, year built, roof renovations, ownership, tenancy.",
         "system_prompt": prompts.RECORDS_PROMPT, "tools": [costar_record], "model": model, "response_format": RecordsOut, "middleware": middleware()},
        {"name": "aerial", "description": "Reads Vexcel attributes for a property id: footprint, height, roof shape, material and condition score, rooftop equipment, existing solar.",
         "system_prompt": prompts.AERIAL_PROMPT, "tools": [vexcel_attributes], "model": model, "response_format": AerialOut, "middleware": middleware()},
        {"name": "interior", "description": "Reads the Matterport twin for a property id: levels scanned, levels below the entrance, floor-to-floor height, coverage.",
         "system_prompt": prompts.INTERIOR_PROMPT, "tools": [twin_levels], "model": model, "response_format": InteriorOut, "middleware": middleware()},
        {"name": "civic", "description": "Reads Los Angeles' own seismic retrofit records for a property id: which retrofit list, order date, step deadlines (with extensions), overdue steps, retrofit permits, and conflicts with CoStar's recorded material.",
         "system_prompt": prompts.CIVIC_PROMPT, "tools": [seismic_status], "model": model, "response_format": CivicOut, "middleware": middleware()},
        # Replaces the auto-added general-purpose subagent, which would inherit every main tool
        # (scene verbs, send_outreach) and the approval gates.
        {"name": "general-purpose", "description": "Explains findings in plain language. Has no tools; never use it to fetch data.",
         "system_prompt": prompts.EXPLAINER_PROMPT, "tools": [], "model": model, "middleware": middleware(tools=False)},
    ]


def _backend() -> CompositeBackend:
    def ns(name: str) -> StoreBackend:
        return StoreBackend(namespace=lambda _rt: (name,))

    # Only file-like data is routed through the backend. queue / acks / outbox / field / scene
    # are plain Store namespaces used directly by tools and routes.
    return CompositeBackend(default=StateBackend(), routes={"/memories/": ns("memories"), "/skills/": ns("skills"), "/properties/": ns("properties")})


def _middleware(live: bool, m: Models | None = None) -> list:
    m = m or MODELS
    if not live:
        return [TodoListMiddleware(system_prompt=prompts.WORKER_TODO_PROMPT), _errors()]
    # The live todo prompt and tool description replace the stock "mark each step complete as soon as it
    # finishes", which cost one or two model turns per question that only updated the list.
    todos = TodoListMiddleware(system_prompt=prompts.TODO_PROMPT, tool_description=prompts.TODO_TOOL_DESCRIPTION)
    return [todos, _errors(), ModelFallbackMiddleware(*m.orch_fallbacks)]


def build(mode: str, store=None, checkpointer=None, m: Models | None = None):
    """On Agent Server leave store/checkpointer as None (the server provides Postgres).
    For local runs pass an InMemoryStore and InMemorySaver."""
    live = mode == "live"
    m = m or MODELS
    solar = LENS == "solar"
    if live and not solar:
        # Seismic lens (the pitch): solar tools stay in the code but are not offered live.
        tools = [*SEISMIC_TOOLS, *CASE_TOOLS, verify_building, field_check, *SIDE_EFFECT_TOOLS, *(t for t in SCENE_TOOLS if t.name != "place_solar")]
    elif live:
        tools = [find_buildings, verify_building, retrofit, field_check, *SIDE_EFFECT_TOOLS, *SCENE_TOOLS]
    else:
        tools = [find_buildings, *SEISMIC_TOOLS, *CASE_TOOLS, verify_building, retrofit, field_check, *SIDE_EFFECT_TOOLS, *QUEUE_TOOLS]
    return create_deep_agent(
        model=m.orch if live else m.worker,
        tools=tools,
        system_prompt=(prompts.LIVE_PROMPT_SOLAR if solar else prompts.LIVE_PROMPT) if live else prompts.WORKER_PROMPT,
        middleware=_middleware(live, m),
        subagents=_specialists(live, m),
        skills=["/skills/"],
        memory=["/memories/AGENTS.md"],
        backend=_backend(),
        interrupt_on={
            "send_outreach": {"allowed_decisions": ["approve", "edit", "reject"]},
            "watch_building": {"allowed_decisions": ["approve", "reject"]},
            "file_correction": {"allowed_decisions": ["approve", "reject"]},
        },
        store=store,
        checkpointer=checkpointer,
        name="radar" if live else "radar_worker",
    )


live_agent = build("live")
worker_agent = build("worker")

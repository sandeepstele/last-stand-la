"""Record and replay model responses: the labelled demo fallback for when Wi-Fi or Vertex fails.

  RADAR_REPLAY=record:<name>   run normally, save every model response to fixtures/replay/<name>.json
  RADAR_REPLAY=fill:<name>     answer from the recording, and record only the steps it is missing (never overwrites):
                               for a variant whose first steps match an existing recording but whose later data differs
  RADAR_REPLAY=<name>          answer from the recording (paced RADAR_REPLAY_DELAY_S apart, default 1.0 s);
                               a question that wasn't recorded goes to the live model as usual
  (unset)                      no wrapper at all: the live path is untouched

Only the models are replayed. Every tool still runs on the cached data, so the 3D scene, the case file and
the evidence images are real. /healthz reports the mode and the UI shows a REPLAY badge: a replay is never
presented as live.

A response is keyed by: which agent is asking (its system prompt), the latest question, how many model turns
have happened since that question, and the data-tool results since then (scene-tool texts, which depend on
the browser's ack timing, are left out). So a re-check after a correction (whose open_case now carries the
team note) is a different key from the first check.
"""

from __future__ import annotations

import hashlib
import re
import uuid
import logging
import json
import os
import threading
import time
from pathlib import Path
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage, message_to_dict, messages_from_dict
from langchain_core.outputs import ChatGeneration, ChatResult

DIR = Path(__file__).resolve().parent.parent / "fixtures" / "replay"
SCENE = {"show_building", "ghost_compare", "reveal_levels", "place_solar"}
DATE = re.compile(r"\d{4}-\d{2}-\d{2}(T[\d:.+-]+Z?)?")  # today's date in notes and trails must not break a recording
_lock = threading.Lock()
log = logging.getLogger("radar.replay")


def mode() -> tuple[str, str] | None:
    v = os.environ.get("RADAR_REPLAY", "").strip()
    if not v:
        return None
    if v.startswith("record:"):
        return "record", v.split(":", 1)[1] or "demo"
    if v.startswith("fill:"):
        return "fill", v.split(":", 1)[1] or "demo"
    return "replay", v


def _text(m: BaseMessage) -> str:
    c = m.content
    return c if isinstance(c, str) else json.dumps(c, sort_keys=True, default=str)


def key(messages: list[BaseMessage]) -> str:
    system = next((_text(m) for m in messages if isinstance(m, SystemMessage)), "")
    last_h = max((i for i, m in enumerate(messages) if isinstance(m, HumanMessage)), default=-1)
    tail = messages[last_h + 1:]
    question = _text(messages[last_h]) if last_h >= 0 else ""
    turns = sum(isinstance(m, AIMessage) for m in tail)
    data = [f"{m.name}:{DATE.sub('<date>', _text(m))}" for m in tail if isinstance(m, ToolMessage) and m.name not in SCENE]
    raw = json.dumps([system, question, turns, data], sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


def _path(name: str) -> Path:
    return DIR / f"{name}.json"


def _load(name: str) -> dict[str, Any]:
    p = _path(name)
    return json.loads(p.read_text()) if p.exists() else {}


def _save(name: str, k: str, msg: AIMessage) -> None:
    with _lock:
        DIR.mkdir(parents=True, exist_ok=True)
        data = _load(name)
        data[k] = message_to_dict(msg)
        _path(name).write_text(json.dumps(data))


class ReplayChatModel(BaseChatModel):
    """Wraps a real chat model; records or replays its responses (see the module doc)."""

    inner: Any
    name_: str = "demo"
    recording: bool = False
    filling: bool = False  # replay hits, record misses

    @property
    def _llm_type(self) -> str:
        return "radar-replay"

    def bind_tools(self, tools: Any, *, tool_choice: Any = None, **kwargs: Any):
        return self.bind(tools=tools, **({"tool_choice": tool_choice} if tool_choice else {}), **kwargs)

    def _bound(self, kwargs: dict[str, Any]):
        tools = kwargs.pop("tools", None)
        choice = kwargs.pop("tool_choice", None)
        model = self.inner.bind_tools(tools, **({"tool_choice": choice} if choice else {})) if tools else self.inner
        return model, kwargs

    def _hit(self, messages: list[BaseMessage]) -> AIMessage | None:
        if self.recording:
            return None
        k = key(messages)
        rec = _load(self.name_).get(k)
        if rec is None:
            system = next((_text(m)[:60] for m in messages if isinstance(m, SystemMessage)), "")
            last_h = max((i for i, m in enumerate(messages) if isinstance(m, HumanMessage)), default=-1)
            log.warning("replay miss %s: system=%r question=%r tail=%s", k, system,
                        _text(messages[last_h])[:80] if last_h >= 0 else "",
                        [type(m).__name__ + (f":{m.name}" if isinstance(m, ToolMessage) else "") for m in messages[last_h + 1:]])
            if os.environ.get("RADAR_REPLAY_STRICT") == "1" and not self.filling:
                raise RuntimeError(f"replay {self.name_} has no recording for this step ({k}); not calling the live model")
            return None
        if not self.filling:
            time.sleep(float(os.environ.get("RADAR_REPLAY_DELAY_S", "1.0")))
        msg = messages_from_dict([rec])[0]
        msg = msg if isinstance(msg, AIMessage) else AIMessage(content=msg.content)
        # fresh ids: a recorded id would make the reducer replace an earlier message instead of appending, and
        # repeated tool_call ids are rejected by some providers
        calls = [dict(tc, id=f"call_{uuid.uuid4().hex[:24]}") for tc in msg.tool_calls]
        return msg.model_copy(update={"id": None, "tool_calls": calls})

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        hit = self._hit(messages)
        if hit is None:
            model, rest = self._bound(dict(kwargs))
            hit = model.invoke(messages, stop=stop, **rest)
            if self.recording or self.filling:
                _save(self.name_, key(messages), hit)
        return ChatResult(generations=[ChatGeneration(message=hit)])

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        import asyncio

        hit = await asyncio.to_thread(self._hit, messages)
        if hit is None:
            model, rest = self._bound(dict(kwargs))
            hit = await model.ainvoke(messages, stop=stop, **rest)
            if self.recording or self.filling:
                await asyncio.to_thread(_save, self.name_, key(messages), hit)
        return ChatResult(generations=[ChatGeneration(message=hit)])


def wrap(model: Any) -> Any:
    m = mode()
    if m is None or isinstance(model, str):
        return model
    return ReplayChatModel(inner=model, name_=m[1], recording=m[0] == "record", filling=m[0] == "fill")

"""Last Stand LA: the `laststand` graph. The same deep agent as the auditor, run as a squad commander.

The agent decides (which checks separate the records, hold or fall back, what a player's tip supports) and
code computes every number (app/fortress.py, app/evidence.py). One thread per night, three kinds of message:
  "Scout property <pid>"             todos + four specialists in parallel + fortress_dossier + open_case,
                                     then the checks it chooses and weigh_case
  "Wave <n> is coming from the <S>"  horde_status + find_fallback, then commit_plan, which waits for HOLD/RUN
  "Tip: <what the player says>"      record_note, then weigh_case again with human_report

The `radar` and `radar_worker` graphs are untouched: this module only reuses their pieces.
"""

from __future__ import annotations

import asyncio
import threading

from deepagents import create_deep_agent
from langchain.agents.middleware import ModelFallbackMiddleware, TodoListMiddleware
from langchain.tools import ToolRuntime, tool
from langchain_core.messages import AIMessage

from app import fortress, prompts
from app.agent import MODELS, _backend, _errors, _specialists
from app.tools import _notes, check_evidence, open_case, record_note, weigh_case


@tool
async def fortress_dossier(pid: str) -> dict:
    """The fortress card for a building in the district: walls, quake, roof, people and space scores (0-100, computed
    in code from CoStar, the city's retrofit lists, the Northridge ShakeMap and Vexcel), what is unknown, the cached
    images, and the open case when the records disagree. Quote its numbers; never compute your own."""
    return await asyncio.to_thread(fortress.dossier, pid)


@tool
def horde_status(wave: int) -> dict:
    """Where wave <wave> is coming from (compass sector), how soon (eta_band) and how big (size_band)."""
    return fortress.horde_status(wave)


@tool
async def find_fallback(pid: str, away_from: str | None = None) -> dict:
    """The strongest building within 600 m of pid to fall back to, preferring ones that lie away from the horde
    (away_from: the wave's sector, e.g. "W"). Ranked in code by walls and quake scores."""
    return await asyncio.to_thread(fortress.find_fallback, pid, away_from)


def _wave_and_checks(runtime: ToolRuntime, pid: str) -> tuple[int, list[str]]:
    """The latest wave asked about and the checks run on pid, read from this thread's own tool calls."""
    wave, checks = 1, []
    for m in (getattr(runtime, "state", None) or {}).get("messages", []):
        for c in getattr(m, "tool_calls", None) or [] if isinstance(m, AIMessage) else []:
            args = c.get("args") or {}
            if c.get("name") == "horde_status" and isinstance(args.get("wave"), int):
                wave = args["wave"]
            if c.get("name") == "check_evidence" and str(args.get("property_id")) == str(pid) and not args.get("suite"):
                if args.get("check") and args["check"] not in checks:
                    checks.append(args["check"])
    return wave, checks


@tool
async def commit_plan(pid: str, action: str, runtime: ToolRuntime, to_pid: str | None = None) -> dict:
    """Commit the squad's plan for this wave: action "hold" (stay in pid) or "run" (fall back to to_pid). ALWAYS
    waits for the player's HOLD or RUN; the player may switch it. Then the wave and an aftershock are rolled in
    code against the walls and quake scores, and the outcome comes back."""
    wave, checks = _wave_and_checks(runtime, pid)
    notes = await _notes(runtime, pid, None)
    if notes and "human_report" not in checks:
        checks.append("human_report")
    return await asyncio.to_thread(fortress.resolve, pid, wave, fortress.SEED, action, to_pid, checks, notes)


GAME_TOOLS = [fortress_dossier, horde_status, find_fallback, commit_plan, open_case, check_evidence, weigh_case, record_note]

GAME_PROMPT = """You are the squad commander in Last Stand LA, a zombie-survival night on real downtown Los Angeles
buildings. The zombies are fake; the buildings and their records are real. You talk like a calm radio operator:
short lines, no fluff. Every number you say comes from a tool result; never compute or invent one.

There are three kinds of message on this channel.

1. "Scout property <pid>"
   In ONE message, call all of these together: write_todos (3-4 short mission objectives), task for each of the four
   squads (records, aerial, interior, civic; give each the property id), fortress_dossier(pid) and open_case(pid).
   If open_case returns a material_conflict, next message: check_evidence for look_from_above and compliance_filings
   in parallel (add one more check only if it clearly separates the hypotheses). Then weigh_case with the checks you
   ran. Then answer with at most 5 radio lines: what each squad found, the walls/quake/roof scores, and the case
   verdict using verdict.text word for word. If there is no case, skip the checks.

2. "Wave <n> is coming from the <sector>"
   In ONE message call horde_status(n) and find_fallback(pid, away_from=<sector>) for the building being scouted.
   Next message: decide. Compare the current building's walls and quake scores (from fortress_dossier or weigh_case)
   with the fallback's reason. Call commit_plan(pid, action="hold") to stay, or commit_plan(pid, action="run",
   to_pid=<fallback>) to move. The player answers HOLD or RUN and may switch your plan. When the result comes back,
   report it in 2 radio lines using its why text. If the player rejects the plan, say "No orders. Holding." and stop.

3. "Tip: <what the player says>"
   Call record_note(property_id, note, source="the player", supports=<city_list_current | costar_current |
   different_structure if clear>). Next message: weigh_case with the checks you ran before plus human_report. Answer in
   2 lines: how the odds moved (from the tool) and that a person's report is strong but capped, never final.

Rules: never name a company (say "a 50-person office"). Never say a record or an owner is wrong; say the records
disagree and which way the evidence leans. Stairs, exits, supplies and parking are not in the data: say so if asked.
Every outcome is a game outcome, not an engineering assessment."""


def build(store=None, checkpointer=None, m=None):
    m = m or MODELS
    todos = TodoListMiddleware(system_prompt=prompts.TODO_PROMPT, tool_description=prompts.TODO_TOOL_DESCRIPTION)
    return create_deep_agent(
        model=m.orch,
        tools=GAME_TOOLS,
        system_prompt=GAME_PROMPT,
        middleware=[todos, _errors(), ModelFallbackMiddleware(*m.orch_fallbacks)],
        subagents=_specialists(True, m),
        skills=["/skills/"],
        memory=["/memories/AGENTS.md"],
        backend=_backend(),
        interrupt_on={"commit_plan": {"allowed_decisions": ["approve", "edit", "reject"]}},
        store=store,
        checkpointer=checkpointer,
        name="laststand",
    )


def _warm() -> None:
    """Precompute the district and every fortress card at startup, so the first click is instant (code only)."""
    try:
        for b in fortress.district()["buildings"]:
            fortress.dossier(b["pid"])
    except Exception:  # no kit on this machine (tests, CI): the routes compute on demand instead
        pass


game_agent = build()
threading.Thread(target=_warm, name="laststand-warm", daemon=True).start()

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
from deepagents.backends import StateBackend
from langchain.agents.middleware import ModelFallbackMiddleware, TodoListMiddleware
from langchain.tools import ToolRuntime, tool
from langchain_core.messages import AIMessage

from app import fortress, prompts
from app.agent import MODELS, _errors, _specialists
from app.tools import _notes, check_evidence, open_case, record_note, weigh_case


async def _outside(*pids: str | None) -> dict | None:
    return await asyncio.to_thread(fortress.outside, *pids)


@tool
async def fortress_dossier(pid: str) -> dict:
    """The fortress card for a building in the district: walls, quake, roof, people and space scores (0-100, computed
    in code from CoStar, the city's retrofit lists, the Northridge ShakeMap and Vexcel), what is unknown, the cached
    images, and the open case when the records disagree. Quote its numbers; never compute your own."""
    return await _outside(pid) or await asyncio.to_thread(fortress.dossier, pid)


@tool
async def night_cases() -> dict:
    """Tonight's shift: the open auditor cases (the same queue a CoStar researcher works) whose building lies in our
    blocks, in queue order with their number n, plus the queue total and how many are in the area. Hedged questions."""
    return await asyncio.to_thread(fortress.night_cases)


@tool
def horde_status(wave: int) -> dict:
    """Where wave <wave> is coming from (compass sector), how soon (eta_band) and how big (size_band)."""
    return fortress.horde_status(wave)


@tool
async def find_fallback(pid: str, away_from: str | None = None) -> dict:
    """The strongest building within 600 m of pid to fall back to, preferring ones that lie away from the horde
    (away_from: the wave's sector, e.g. "W"). Ranked in code by walls and quake scores."""
    return await _outside(pid) or await asyncio.to_thread(fortress.find_fallback, pid, away_from)


def _wave_and_checks(runtime: ToolRuntime, pid: str, suite: str | None = None) -> tuple[int, list[str]]:
    """The latest wave asked about and the checks run on pid (and suite), read from this thread's own tool calls."""
    from app.tenants import norm_suite

    wave, checks, su = 1, [], norm_suite(suite) if suite else None
    for m in (getattr(runtime, "state", None) or {}).get("messages", []):
        for c in getattr(m, "tool_calls", None) or [] if isinstance(m, AIMessage) else []:
            args = c.get("args") or {}
            if c.get("name") == "horde_status" and isinstance(args.get("wave"), int):
                wave = args["wave"]
            if c.get("name") == "check_evidence" and str(args.get("property_id")) == str(pid) \
                    and (norm_suite(args.get("suite")) if args.get("suite") else None) == su:
                if args.get("check") and args["check"] not in checks:
                    checks.append(args["check"])
    return wave, checks


@tool
async def draft_correction(property_id: str, runtime: ToolRuntime, suite: str | None = None) -> dict:
    """Dawn debrief for ONE case you worked tonight (call it once per case: the building, or the building and suite).
    Returns the case's verdict and a hedged correction draft built in code from tonight's evidence, citing the player's
    report if they made one. Nothing is sent: the player files it in the auditor."""
    if bad := await _outside(property_id):
        return bad
    _, checks = _wave_and_checks(runtime, property_id, suite)
    notes = await _notes(runtime, property_id, suite)
    return await asyncio.to_thread(fortress.draft, property_id, suite, checks, notes)


@tool
async def commit_plan(pid: str, action: str, runtime: ToolRuntime, to_pid: str | None = None) -> dict:
    """Commit the squad's plan for this wave: action "hold" (stay in pid) or "run" (fall back to to_pid). ALWAYS
    waits for the player's HOLD or RUN; the player may switch it. Then the wave and an aftershock are rolled in
    code against the walls and quake scores, and the outcome comes back."""
    if bad := await _outside(pid, to_pid if action == "run" else None):
        return bad
    wave, checks = _wave_and_checks(runtime, pid)
    notes = await _notes(runtime, pid, None)
    if notes and "human_report" not in checks:
        checks.append("human_report")
    return await asyncio.to_thread(fortress.resolve, pid, wave, fortress.SEED, action, to_pid, checks, notes)


GAME_TOOLS = [night_cases, fortress_dossier, horde_status, find_fallback, commit_plan, draft_correction, open_case, check_evidence, weigh_case, record_note]

GAME_PROMPT = """You are the squad commander in Last Stand LA, a zombie-survival night shift on real downtown Los Angeles
buildings. The zombies are fake; the buildings, the records and the cases are real: they come from the same queue a CoStar
researcher works. You talk like a calm radio operator: short lines, no fluff. Every number you say comes from a tool
result; never compute or invent one.

Messages on this channel, in the order a night usually runs:

1. "Brief the night shift"
   Call night_cases(). Next message: write_todos with one item per case it returns (e.g. "Case #7: suite 1100, 122 7th
   St: is the tenant still there?") plus "Survive the night". Then answer in at most 3 radio lines: how many open cases
   the queue holds and how many are in our blocks (total, in_area), and tonight's cases with their stakes. No other tools.

2. "Check suite <suite> at building <pid>: is the tenant on record still there?"
   Call open_case(property_id=<pid>, suite=<suite>). Next message: check_evidence in parallel for the 2-3 checks most
   likely to separate the hypotheses (from suite_tour, listing_timeline, tenancy_trail, lease_terms, lot_activity; pass
   suite). Then weigh_case(property_id, case="ghost_tenant", checks, suite). Answer in at most 4 lines with verdict.text
   word for word.

3. "Tip: I'm inside suite <suite>. ..."  (a report about the suite case)
   Call record_note(property_id=<that building>, suite=<suite>, note=<the report>, source="the player", supports=
   <gone_dark if they say it is empty | still_there if people are working there | omit if they can't tell>). Next message:
   weigh_case for the ghost_tenant case with the checks you ran before plus human_report (pass suite). Answer in 2 lines:
   how the odds moved (from the tool) and that a person's report is strong but capped, never final.

4. "Scout property <pid>"
   In ONE message, call all of these together: write_todos (3-4 short mission objectives), task for each of the four
   squads (records, aerial, interior, civic; give each the property id), fortress_dossier(pid) and open_case(pid).
   If open_case returns a material_conflict, next message: check_evidence for look_from_above and compliance_filings
   in parallel (add one more check only if it clearly separates the hypotheses). Then weigh_case with the checks you
   ran. Then answer with at most 5 radio lines: what each squad found, the walls/quake/roof scores, and the case
   verdict using verdict.text word for word. If there is no case, skip the checks.

5. "Tip: I'm inside the building. ..."  (a report about the walls of the scouted building)
   Call record_note(property_id=<the scouted building>, note, source="the player", supports=<city_list_current if they
   say concrete | costar_current if they say brick | omit if they can't tell>). Next message: weigh_case for the
   material_conflict with the checks you ran before plus human_report. Answer in 2 lines: how the odds moved (from the
   tool) and that a person's report is strong but capped, never final.

6. "Wave <n> is coming from the <sector>"
   In ONE message call horde_status(n) and find_fallback(pid, away_from=<sector>) for the scouted building.
   Your NEXT message MUST call commit_plan, with no answer text before it: compare the scouted building's walls and
   quake scores (from fortress_dossier or weigh_case) with the fallback's reason, then call commit_plan(pid,
   action="hold") to stay or commit_plan(pid, action="run", to_pid=<fallback>) to move. A wave message never ends
   without commit_plan: the player answers HOLD or RUN through it and may switch your plan. When the result comes back,
   report it in 2 radio lines using its why text. If the player rejects the plan, say "No orders. Holding." and stop.

7. "Debrief the night shift"  (dawn, after the night resolves)
   In ONE message call draft_correction once for each case you opened tonight on this thread (the building for the
   walls case; the building and suite for the suite case). Then answer in at most 3 radio lines: each case's verdict in
   words and that the drafts wait for the player to file them. Never say a record is wrong; a draft asks a researcher
   to review.

The scouted building, for waves, fallbacks and walls reports, is ALWAYS the property id from this thread's latest "Scout
property <pid>" message. A suite question names its own building and suite. Never use any other id, from memory or
anywhere else; a fallback building comes only from find_fallback.

Rules: name buildings by their address label (e.g. "737 Broadway"), never by property id, and say hypotheses in words
("concrete, as the city lists it", "the material CoStar records", "a different structure", "still there", "gone"), never
as keys like city_list_current. Never name a company (say "a 3-person office"). Never say a record or an owner is wrong;
say the records disagree and which way the evidence leans. Stairs, exits, supplies and parking are not in the data:
say so if asked. Every outcome is a game outcome, not an engineering assessment."""

GAME_TODO_PROMPT = """## The plan on screen (write_todos)
The todo list is shown live on the HQ panel. In a briefing, write it right after night_cases returns. When scouting,
write it in your first message together with your first tool calls. Update it only in a message that also calls other
tools, mark items completed in the message whose tool calls finish them, and never call write_todos in an answer."""


def build(store=None, checkpointer=None, m=None):
    m = m or MODELS
    todos = TodoListMiddleware(system_prompt=GAME_TODO_PROMPT, tool_description=prompts.TODO_TOOL_DESCRIPTION)
    return create_deep_agent(
        model=m.orch,
        tools=GAME_TOOLS,
        system_prompt=GAME_PROMPT,
        middleware=[todos, _errors(), ModelFallbackMiddleware(*m.orch_fallbacks)],
        subagents=_specialists(True, m),
        # Its own scratch space only: the auditor's memories and worklog (other buildings) stay out of the game.
        # Player tips still go to the shared Store through record_note.
        backend=StateBackend(),
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

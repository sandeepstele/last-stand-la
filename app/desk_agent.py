"""Bob's Desk: the `desk` graph. The same deep agent as Last Stand, run as a city building-office analyst.

Bob works one shift on real downtown LA buildings: a daylight office day (the city's retrofit deadline; real queue cases
in his inbox), a quake at 5 pm, rapid safety tags at night, and an aftershock at dawn that tests them. The agent decides
(which checks separate the records, which building to tag first, what a tip supports) and code computes every number
(app/desk.py screening, people and the aftershock; app/evidence.py the odds). Messages, in shift order:
  "Start Bob's shift"                      inbox + last shift's log, then the plan
  "Check suite <s> at building <pid>: ..." the ghost-tenant case (same as Last Stand)
  "Inspect building <pid>"                 four squads + building_card + open_case, then checks and weigh_case
  "Tip: ..."                               record_note, then weigh_case again with human_report
  "Quake at 5:02 pm. Tag building <pid>"   screen_building + triage, then tag_building, which waits for Bob's call
  "End the shift"                          critic, drafts, shift_report (the aftershock and the score), log_shift

The `laststand` graph and its recording are untouched: this module only reuses their pieces. Its replay keys differ
(another system prompt), so one recording file can hold both graphs.
"""

from __future__ import annotations

import asyncio
import os
import re
from datetime import date

from deepagents import create_deep_agent
from deepagents.backends import CompositeBackend, StateBackend, StoreBackend
from langchain.agents.middleware import AgentMiddleware, ModelFallbackMiddleware, TodoListMiddleware
from langchain.tools import ToolRuntime, tool
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from app import desk, fortress, prompts
from app.agent import MODELS, _errors, _specialists, make_model
from app import evidence
from app.game_agent import (CriticOut, NightStart, _hints, _outside as _game_outside, _payload, _echoes_player,
                            _wave_and_checks, case_file, draft_correction, run_check, weigh_case)
from app.guards import DISCLAIMER, RetryBlank, _last_ai, _replace, _text, latest_verdict
from app.tools import _notes, record_note

LOG_NS = ("desk_log",)
START = "start bob's shift"
QUAKE = "Quake at "


OUTSIDE = ("{pid} is not a building in Bob's district. The building is the property id in this thread's latest "
           "'Inspect building <pid>' or 'Tag building <pid>' message; use that one.")


async def _outside(*pids: str | None) -> dict | None:
    bad = await _game_outside(*pids)
    if bad:
        p = next((x for x in pids if x is not None and str(x) in bad["error"]), pids[0])
        return {"error": OUTSIDE.format(pid=p)}
    return None


# ------------------------------------------------------------------ middleware (re-keyed from Last Stand's)


class ShiftStart(NightStart):
    """A shift starts clean: the pinned cases lose earlier reports and critic files (the same reasons as Last Stand's
    NightStart, keyed to "Start Bob's shift"). Under replay an empty shift log gets the seeded previous shift; a log
    with Bob's real last shift is kept, so the agent opens with what he actually corrected."""

    @staticmethod
    def _is_start(state) -> bool:
        msgs = (state or {}).get("messages") or []
        last_h = max((i for i, m in enumerate(msgs) if isinstance(m, HumanMessage)), default=-1)
        if last_h < 0 or any(isinstance(m, AIMessage) for m in msgs[last_h + 1:]):
            return False
        return desk.parse_day(_text(msgs[last_h])) is not None  # "Start Bob's shift" (day 1) or "..., day k"

    async def abefore_agent(self, state, runtime):
        store = getattr(runtime, "store", None)
        if store is None or not self._is_start(state):
            return None
        from app import replay
        from app.tools import _note_key

        for pid, suite in fortress.NIGHT_PIN | desk.day_pins():
            for it in await store.asearch(("notes", _note_key(pid, suite)), limit=100):
                await store.adelete(it.namespace, it.key)
        for it in await store.asearch(("laststand_cases",), limit=200):
            await store.adelete(it.namespace, it.key)
        msgs = (state or {}).get("messages") or []
        last_h = max((i for i, m in enumerate(msgs) if isinstance(m, HumanMessage)), default=-1)
        day = desk.parse_day(_text(msgs[last_h])) if last_h >= 0 else None
        # Day 1 starts a career: it always opens from the seeded previous shift (a reload, crash or second tab starts
        # clean and replays). Later days keep the real log, so they open with Bob's actual correction.
        if replay.mode() is not None and (day == 1 or not await store.aget(LOG_NS, "/latest.md")):
            from deepagents.backends.utils import create_file_data

            await store.aput(LOG_NS, "/latest.md", create_file_data(desk.LOG_SEED))
        return None


def _screened(messages) -> dict | None:
    """The latest successful screen_building result since the last human message (None if none, or it failed)."""
    last_h = max((i for i, m in enumerate(messages) if isinstance(m, HumanMessage)), default=-1)
    for m in reversed(messages[last_h + 1:]):
        if isinstance(m, ToolMessage) and m.name == "screen_building":
            d = _result(m.content)
            return d if d and not d.get("error") and d.get("pid") and d.get("suggest") else None
    return None


def needs_tag(messages) -> bool:
    """True after a "Quake at ..." message once screen_building has answered (successfully) and tag_building hasn't
    been called yet."""
    last_h = max((i for i, m in enumerate(messages) if isinstance(m, HumanMessage)), default=-1)
    if last_h < 0 or not _text(messages[last_h]).strip().startswith(QUAKE):
        return False
    tail = messages[last_h + 1:]
    asked = any(isinstance(m, AIMessage) and any(c.get("name") == "tag_building" for c in m.tool_calls or []) for m in tail)
    sc = _screened(messages)
    named = re.search(r"Tag building (\d+)", _text(messages[last_h]))
    if sc is None or (named and named.group(1) != str(sc["pid"])):
        return False  # no screening, or the screened building isn't the one Bob named: never force a proposal
    return not asked


def _pin(result, screened: dict):
    """The forced proposal is the code's: tag_building's args become the screened building and its suggested tag."""
    ai = _last_ai(result)
    if ai is None:
        return result
    calls = [dict(c, args={"pid": str(screened["pid"]), "tag": screened["suggest"]}) if c.get("name") == "tag_building" else c
             for c in ai.tool_calls or []]
    if calls == list(ai.tool_calls or []):
        return result
    new = ai.model_copy(update={"tool_calls": calls})
    if isinstance(result, AIMessage):
        return new
    result.result = [new if m is ai else m for m in result.result]
    return result


class ForceTag(AgentMiddleware):
    """Bob's tag decision is never skipped: once the screening is in, the next model call must call tag_building, and
    the proposal is pinned to the screened building and the code's suggestion (the model never picks the colour)."""

    def wrap_model_call(self, request, handler):
        if not needs_tag(request.messages):
            return handler(request)
        return _pin(handler(request.override(tool_choice="tag_building")), _screened(request.messages))

    async def awrap_model_call(self, request, handler):
        if not needs_tag(request.messages):
            return await handler(request)
        return _pin(await handler(request.override(tool_choice="tag_building")), _screened(request.messages))


class DeskRetryBlank(RetryBlank):
    """A blank answer after a tag or the shift report speaks that tool's own code-built line, not "say again"."""

    def _say(self, request) -> str:
        msgs = getattr(request, "messages", []) or []
        last_h = max((i for i, m in enumerate(msgs) if isinstance(m, HumanMessage)), default=-1)
        for m in reversed(msgs[last_h + 1:]):
            if isinstance(m, ToolMessage) and m.name in ("tag_building", "shift_report"):
                d = _result(m.content) or {}
                if m.name == "tag_building" and d.get("why"):
                    return d["why"]
                if m.name == "shift_report" and d.get("buildings") is not None:
                    return (f"Dawn: {d.get('people_safe')} of {d.get('people_at_stake')} people kept safe, "
                            f"{d.get('people_displaced')} displaced, {d.get('records_fixed')} record(s) fixed.")
        return latest_verdict(msgs) or self.fallback


class TagDisclaimer(AgentMiddleware):
    """A spoken tag or shift outcome always carries the disclaimer: added in code if the model dropped it."""

    @staticmethod
    def _fix(request, result):
        msgs = getattr(request, "messages", []) or []
        last_h = max((i for i, m in enumerate(msgs) if isinstance(m, HumanMessage)), default=-1)
        if not any(isinstance(m, ToolMessage) and m.name in ("tag_building", "shift_report") for m in msgs[last_h + 1:]):
            return result
        ai = _last_ai(result)
        if ai is None or ai.tool_calls or "not an engineering assessment" in _text(ai).lower() or not _text(ai).strip():
            return result
        return _replace(result, _text(ai).rstrip() + "\n" + DISCLAIMER)

    def wrap_model_call(self, request, handler):
        return self._fix(request, handler(request))

    async def awrap_model_call(self, request, handler):
        return self._fix(request, await handler(request))


# ------------------------------------------------------------------ desk tools (numbers in code: app/desk.py)


def _day(runtime: ToolRuntime) -> int:
    """The day this thread is working: from its "Start Bob's shift[, day k]" message (day 1 if none)."""
    for m in (getattr(runtime, "state", None) or {}).get("messages", []):
        if isinstance(m, HumanMessage) and (d := desk.parse_day(_text(m))):
            return d
    return 1


def _thread_checks(runtime: ToolRuntime, pid: str) -> list[str]:
    return _wave_and_checks(runtime, pid)[1]


async def _evidence(runtime: ToolRuntime, pid: str) -> tuple[list[str], list[dict]]:
    checks = _thread_checks(runtime, pid)
    notes = await _notes(runtime, pid, None)
    if notes and "human_report" not in checks:
        checks.append("human_report")
    return checks, notes


@tool
async def open_case(property_id: str, runtime: ToolRuntime, suite: str | None = None) -> dict:
    """Open a record case on Bob's desk and show code-measured hints for the checks available here."""
    if bad := await _outside(property_id):
        return bad
    out = await asyncio.to_thread(evidence.open_case, property_id, suite)
    notes = await _notes(runtime, property_id, suite)
    if notes:
        out["team_notes"] = [{"note": n.get("note"), "noted_on": n.get("at"), "source": n.get("source")} for n in notes]
        for case_data in out.get("cases", []):
            if not any(c["check"] == "human_report" for c in case_data["checks"]):
                case_data["checks"].append({"check": "human_report", "looks_at": evidence.CHECK_WHAT["human_report"]})
    stats = await asyncio.to_thread(evidence.check_stats)

    def attach() -> None:  # _hints globs the image cache: off the event loop
        for case_data in out.get("cases", []):
            case_data["check_hints"] = _hints(property_id, case_data, suite, stats, None)  # no night-game memory
    await asyncio.to_thread(attach)
    return out


@tool
async def inbox(runtime: ToolRuntime) -> dict:
    """Today's desk inbox: how many open record cases the queue holds, how many lie in Bob's district, and today's
    cases with their stakes (real queue cases; hedged questions, no company names)."""
    day = _day(runtime)
    if day == 1:  # the recorded stage shift: exactly as before
        return await asyncio.to_thread(fortress.night_cases)
    return await asyncio.to_thread(desk.day_inbox, day)


@tool
async def building_card(pid: str, runtime: ToolRuntime) -> dict:
    """The building's live card, one line per data source (CoStar record, Vexcel aerial, Matterport scan, city retrofit
    list, 1994 ShakeMap), plus the people inside by time of day and the rapid screening score, all computed in code."""
    if bad := await _outside(pid):
        return bad
    checks, notes = await _evidence(runtime, pid)
    return await asyncio.to_thread(desk.card, pid, checks, notes)


@tool
async def screen_building(pid: str, runtime: ToolRuntime) -> dict:
    """Rapid post-quake screening of one building, in code: the screening score for each material the evidence still
    allows (weighted by today's odds), the chance of serious damage in the aftershock, the people who would be inside,
    and the tag the code suggests (green, yellow or red) with why."""
    if bad := await _outside(pid):
        return bad
    checks, notes = await _evidence(runtime, pid)
    return await asyncio.to_thread(desk.screen, pid, checks, notes)


@tool
async def triage() -> dict:
    """The district's buildings ranked by people at risk in the aftershock (code), for the map and the tagging order."""
    return await asyncio.to_thread(desk.triage)


@tool
async def tag_building(pid: str, tag: str, runtime: ToolRuntime) -> dict:
    """Propose Bob's safety tag for one building: "green" (inspected), "yellow" (restricted use) or "red" (unsafe).
    ALWAYS waits for Bob, who may approve or change it. The tag is recorded for the dawn aftershock."""
    if bad := await _outside(pid):
        return bad
    msgs = (getattr(runtime, "state", None) or {}).get("messages", [])
    sc = _screened(msgs)
    last_h = max((i for i, m in enumerate(msgs) if isinstance(m, HumanMessage)), default=-1)
    named = re.search(r"Tag building (\d+)", _text(msgs[last_h])) if last_h >= 0 else None
    if not sc or str(sc["pid"]) != str(pid) or (named and named.group(1) != str(pid)):
        return {"error": "Tags come only after the quake: screen_building for this building first, in a 'Quake at ...' turn."}
    checks, notes = await _evidence(runtime, pid)
    return await asyncio.to_thread(desk.tag, pid, tag, checks, notes)


def _result(content) -> dict | None:
    """A tool result as a dict, also when the interrupt prefixed it ("a human reviewer replaced this tool call ...
    Tool response: {...}"), which is what an edited tag looks like."""
    from app.agentlog import _json

    d = _payload(content)
    if d is None:
        d = _json(content)
    return d if isinstance(d, dict) else None


def _tags(runtime: ToolRuntime) -> list[dict]:
    """The tags Bob confirmed on this thread (tag_building results, latest per building)."""
    out: dict[str, dict] = {}
    for m in (getattr(runtime, "state", None) or {}).get("messages", []):
        if isinstance(m, ToolMessage) and m.name == "tag_building":
            d = _result(m.content)
            if d and d.get("pid") and not d.get("error"):
                out[str(d["pid"])] = d
    return list(out.values())


def _drafts(runtime: ToolRuntime) -> list[dict]:
    out = []
    for m in (getattr(runtime, "state", None) or {}).get("messages", []):
        if isinstance(m, ToolMessage) and m.name == "draft_correction":
            d = _result(m.content)
            if d and not d.get("error"):
                out.append(d)
    return out


@tool
async def shift_report(runtime: ToolRuntime) -> dict:
    """Dawn: the aftershock hits (seeded, in code) and tests every tag Bob confirmed today. Returns, per building, what
    happened and the people kept safe, plus the records fixed (drafts a reviewer agreed with). Call it after the drafts."""
    tags = _tags(runtime)
    return await asyncio.to_thread(desk.shift_report, tags, {}, _drafts(runtime), _day(runtime))


async def _log_text(runtime: ToolRuntime) -> str:
    if not getattr(runtime, "store", None):
        return ""
    item = await runtime.store.aget(LOG_NS, "/latest.md")
    if not item:
        return ""
    from deepagents.backends.utils import file_data_to_string

    return file_data_to_string(item.value)


def _shift_facts(runtime: ToolRuntime) -> list[str]:
    lines = []
    for m in (getattr(runtime, "state", None) or {}).get("messages", []):
        d = _result(m.content) if isinstance(m, ToolMessage) and m.name == "shift_report" else None
        if d:
            tagged = {str(x.get("pid")): x for x in _tags(runtime)}
            lines = []
            for r in d.get("buildings") or []:
                sug = (tagged.get(str(r["pid"])) or {}).get("suggested") or "unknown"
                b = lambda v: str(bool(v)).lower()
                if r.get("right_tag") is None:  # days 2+: no aftershock, graded by the screening
                    lines.append(f"- {r['label']}: agent_suggested={sug}; bob_tag={r['tag']}; agreed={b(sug == r['tag'])}; "
                                 f"aftershock=none; expected_exposed={r.get('people_exposed')}; people_at_stake={r['people_at_stake']}")
                    continue
                lines.append(f"- {r['label']}: agent_suggested={sug}; bob_tag={r['tag']}; agreed={b(sug == r['tag'])}; "
                             f"damage={r.get('damage')}; right_tag={r.get('right_tag')}; bob_right={b(r.get('tag_right'))}; "
                             f"agent_right={b(sug == r.get('right_tag'))}; people_safe={r['people_safe']}")
            lines.append(f"- score: people_safe={d.get('people_safe')}/{d.get('people_at_stake')}"
                         + ("" if d.get("aftershock", True) else " (expected; no aftershock)")
                         + f"; records_fixed={d.get('records_fixed')}")
    return lines


@tool
async def log_shift(runtime: ToolRuntime, lesson: str = "") -> dict:
    """Write this shift's code-built facts and one short lesson to Bob's shift log (memory for the next shift)."""
    if not getattr(runtime, "store", None):
        return {"status": "not_saved", "reason": "no persistent store"}
    facts = _shift_facts(runtime)
    previous = await _log_text(runtime)
    old = [p.strip() for p in re.split(r"(?m)(?=^## Shift )", previous) if p.strip()]
    day = _day(runtime)
    body = [f"## Shift {date.today().isoformat()}" + (f" (day {day})" if day > 1 else ""), *(facts or ["- no shift report available"])]
    lesson = " ".join(lesson.split())
    nums, known = set(re.findall(r"\d+(?:\.\d+)?", lesson)), set(re.findall(r"\d+(?:\.\d+)?", "\n".join(body)))
    ok = len(lesson.split()) <= 20 and nums <= known and not _echoes_player(runtime, lesson)
    if lesson and ok:
        body.append(f"Lesson: {lesson}")
    shifts = (old + ["\n".join(body)])[-3:]
    while len("\n\n".join(shifts).encode()) > 1024 and len(shifts) > 1:
        shifts.pop(0)
    text = "\n\n".join(shifts)[:1024]
    from deepagents.backends.utils import create_file_data

    await runtime.store.aput(LOG_NS, "/latest.md", create_file_data(text))
    return {"status": "saved", "shifts_kept": len(shifts), "lesson_saved": bool(lesson and ok),
            **({"lesson_status": "rejected: max 20 words or contains a number not in this log"} if lesson and not ok else {})}


DESK_TOOLS = [inbox, building_card, screen_building, triage, tag_building, shift_report, log_shift,
              draft_correction, open_case, run_check, weigh_case, record_note]

DESK_CRITIC_PROMPT = """You are the review desk for one of Bob's record cases. Call case_file once for the exact property and suite in
the task (the case_ref marker). Judge only whether that code-built evidence trail supports its verdict: follows=true if
it does, false if a step doesn't hold. Give one plain-words why of at most 25 words (no numbers, no ids, no company names) and the weakest
link (a check name, or case_file if you couldn't read it). Never say a record or an owner is wrong."""


def _subagents(m) -> list[dict]:
    specs = _specialists(True, m)
    timeout = float(os.environ.get("RADAR_MODEL_TIMEOUT_S", "8")) or 8.0
    critic_name = os.environ.get("RADAR_CRITIC_MODEL", "gemini-3.5-flash-lite")
    if critic_name.startswith("gemini") and not os.environ.get("GOOGLE_API_KEY"):
        critic, fallback = m.spec, m.orch
    else:
        critic = make_model(critic_name, "low", timeout=timeout, attempts=1)
        fallback = make_model("gemini-3.8-flash", "low", timeout=timeout, attempts=1)
        from app import replay

        if replay.mode() is not None:
            critic, fallback = replay.wrap(critic), replay.wrap(fallback)
    specs.append({"name": "critic", "description": "Reviews whether one case's code-built evidence supports its verdict.",
                  "system_prompt": DESK_CRITIC_PROMPT, "tools": [case_file], "model": critic,
                  "response_format": CriticOut, "middleware": [_errors(), ModelFallbackMiddleware(fallback)]})
    return specs


DESK_PROMPT = """You are Bob's analyst at a city building office in downtown Los Angeles. Bob is the employee on shift; you run his
squads and his numbers. The buildings, the records and the cases are real: they come from the same queue a CoStar
researcher works, and from the city's own retrofit lists. Today is the city's retrofit deadline; at 5 pm a quake hits
and Bob tags buildings before the dawn aftershock. You talk like a sharp colleague on the office radio: short lines, no
fluff. Every number you say comes from a tool result; never compute or invent one.

Messages, in the order a shift usually runs:

1. "Start Bob's shift"
   In ONE message call inbox() and read_file("/shift_log/latest.md"). Next message: write_todos with one item per case
   the inbox returns (e.g. "Case #7: suite 1100, 122 7th St: is the tenant still there?") plus "Tag the block before the
   aftershock". Then answer in at most 4 lines. If the log's last shift has agreed=false (Bob changed your tag), your
   FIRST line says so plainly, from the log only, e.g. "Last shift Bob changed my yellow to red at 601 Broadway, and
   the aftershock showed red was right." Then: how many open cases the queue holds and how many are in Bob's district
   (total, in_area), today's cases with their stakes, and the last shift's lesson if the log has one (no facts beyond it).

2. "Check suite <suite> at building <pid>: is the tenant on record still there?"
   Call open_case(property_id=<pid>, suite=<suite>). Next message: choose the two available checks with the highest
   expected_move in check_hints and call run_check for both in parallel, passing suite. Each why is one short line that
   quotes that hint's moved_odds_in and typical_move. Then call weigh_case(property_id, case="ghost_tenant", checks,
   suite). If the leader is still under 50% and another check is available, run the next-highest hint and weigh again.
   Answer in at most 4 lines with the final verdict.text word for word.

3. "Tip: I'm inside suite <suite>. ..."  (Bob's report about the suite case)
   Call record_note(property_id=<that building>, suite=<suite>, note=<the report>, source="the player", supports=
   <gone_dark if he says it is empty | still_there if people are working there | omit if he can't tell>). Next message:
   weigh_case for the ghost_tenant case with the checks you ran before plus human_report (pass suite). Answer in 2 lines:
   how the odds moved (from the tool) and that a person's report is strong but capped, never final.

4. "Inspect building <pid>"
   In ONE message, call all of these together: write_todos (3-4 short objectives), task for each of the four squads
   (records, aerial, interior, civic; give each the property id), building_card(pid) and open_case(pid).
   If open_case returns a material_conflict, next message: choose the two available checks with the highest expected_move
   in check_hints and call run_check for both in parallel. Each why is one short line quoting that hint's moved_odds_in
   and typical_move. Then weigh_case with those checks. If the leader is still under 50% and another check is available,
   run the next-highest hint and weigh again. Then answer in at most 5 lines: what each squad found, the people inside
   and the screening score from building_card, and the final verdict using verdict.text word for word. If there is no
   case, skip the checks.

5. "Tip: I'm inside the building. ..."  (Bob's report about the walls of the inspected building)
   In ONE message call record_note(property_id=<the inspected building>, note, source="the player", supports=
   <city_list_current if he says concrete | costar_current if he says brick | omit if he can't tell>) AND, if
   check_hints lists interior_geometry as available, run_check(case="material_conflict", check="interior_geometry",
   why=<one line: you're measuring the room Bob is standing in from its 3D scan>). Next message: weigh_case for the
   material_conflict with the checks you ran before plus interior_geometry (if you ran it) plus human_report. Answer in
   2 lines: how the odds moved (from the tool) and that a person's report is strong but capped, never final.

6. "Quake at 5:02 pm. Tag building <pid>"
   In ONE message call screen_building(pid) and triage(). Your NEXT message MUST call tag_building, with no answer text
   before it: propose tag_building(pid, tag=<screen_building's suggest>). Bob approves or changes it. When the result
   comes back, answer in 2 lines: the tag and its why (from the tool), and where triage says the next-most people are
   at risk. If Bob rejects the tag, say "No tag. The building stays open." and stop.

7. "End the shift"  (dawn)
   In ONE message call task once per case opened on this thread, in parallel: assign each to critic with the exact
   case_ref=<property_id>:<normalized-suite-or-dash> marker and tell it to call case_file for that case and return
   CriticOut. Next message: draft_correction once per case (the building for the walls case; the building and suite for
   the suite case). Next message: shift_report(). Next message: log_shift with one lesson line of at most 20 words (no
   number unless it appears in the shift report; never a company name or Bob's own words). If Bob changed your tag,
   the lesson says what you will weigh differently next shift. Then answer in at most 4
   lines: what the aftershock did to each tagged building and the people kept safe (from shift_report), and each case's
   draft (its text starts with "DRAFT") waiting for Bob to file it, or that none is drafted yet.

The inspected building, for walls reports and tags, is ALWAYS the property id from this thread's latest "Inspect
building <pid>" or "Tag building <pid>" message. A suite question names its own building and suite. Never use any other
id, from memory or anywhere else.

Rules: name buildings by their address label (e.g. "737 Broadway"), never by property id, and say hypotheses in words
("concrete, as the city lists it", "the material CoStar records", "a different structure", "still there", "gone"), never
as keys like city_list_current. Never name a company (say "a 3-person office"). Never say a record or an owner is wrong;
say the records disagree and which way the evidence leans. Exits, stairs and soil are not in the data: say so if asked.
Before a "Quake at ..." message, never name a tag colour and never say whether a building is safe to enter: give the
screening score and the people only. Tags exist only after the quake, as simulated post-quake placards, and only
through tag_building. Tags and the aftershock are game outcomes, not engineering assessments."""

DESK_TODO_PROMPT = """## The plan on screen (write_todos)
The todo list is shown live on Bob's desk. At the start of the shift, write it right after inbox returns. When
inspecting, write it in your first message together with your first tool calls. Update it only in a message that also
calls other tools, mark items completed in the message whose tool calls finish them, and never call write_todos in an answer."""


def build(store=None, checkpointer=None, m=None):
    m = m or MODELS
    todos = TodoListMiddleware(system_prompt=DESK_TODO_PROMPT, tool_description=prompts.TODO_TOOL_DESCRIPTION)
    backend = CompositeBackend(default=StateBackend(), routes={"/shift_log/": StoreBackend(namespace=lambda _rt: LOG_NS)})
    return create_deep_agent(
        model=m.orch,
        tools=DESK_TOOLS,
        system_prompt=DESK_PROMPT,
        middleware=[ShiftStart(), todos, _errors(), TagDisclaimer(), DeskRetryBlank("The line dropped. Say again?"), ForceTag(),
                    ModelFallbackMiddleware(*m.orch_fallbacks)],
        subagents=_subagents(m),
        backend=backend,
        interrupt_on={"tag_building": {"allowed_decisions": ["approve", "edit", "reject"]}},
        store=store,
        checkpointer=checkpointer,
        name="desk",
    )


desk_agent = build()


def _warm() -> None:
    """Precompute the district and citywide screening at startup, so the desk map is instant (code only)."""
    for scope in ("district", "city"):
        try:
            desk.triage(scope)
        except Exception:  # no kit on this machine (tests, CI): computed on demand instead
            pass


import threading  # noqa: E402

threading.Thread(target=_warm, name="desk-warm", daemon=True).start()

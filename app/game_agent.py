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
import json
import os
import re
import threading
from datetime import date
from pathlib import Path
from typing import Any

from deepagents import create_deep_agent
from deepagents.backends import CompositeBackend, StateBackend, StoreBackend
from langchain.agents.middleware import ModelFallbackMiddleware, TodoListMiddleware
from langchain.tools import ToolRuntime, tool
from langchain_core.messages import AIMessage, ToolMessage
from pydantic import BaseModel

from app import evidence, fortress, layers, prompts, vision
from app.agent import MODELS, _errors, _specialists, make_model
from app.guards import ForceCommitPlan, RetryBlank
from app.tools import _notes, record_note


class CriticOut(BaseModel):
    follows: bool
    weakest_link: str
    why: str


CRITIC_PROMPT = """You are the dawn critic for one Last Stand case. Call case_file once for the exact property and suite in
your task. Judge only whether the code-built evidence trail supports the verdict. Do not read or quote the commander's
narrative. If evidence is missing, contradictory, or weak, set follows=false. Return CriticOut with weakest_link naming
one check and why under 25 words. You cannot change a probability or propose a stronger verdict."""


def _flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def _thread_id(runtime: ToolRuntime) -> str | None:
    return str(((getattr(runtime, "config", None) or {}).get("configurable") or {}).get("thread_id") or "") or None


def _case_key(pid: str, suite: str | None) -> str:
    from app.tenants import norm_suite

    return f"{pid}:{norm_suite(suite) if suite else '-'}"


async def _remember_case(runtime: ToolRuntime, pid: str, suite: str | None, value: dict) -> None:
    if not _flag("RADAR_CRITIC") or not getattr(runtime, "store", None) or not _thread_id(runtime):
        return
    await runtime.store.aput(("laststand_cases", _thread_id(runtime)), _case_key(pid, suite), value)


async def _night_log_text(runtime: ToolRuntime) -> str:
    if not getattr(runtime, "store", None):
        return ""
    item = await runtime.store.aget(("laststand_log",), "/latest.md")
    if not item:
        return ""
    from deepagents.backends.utils import file_data_to_string

    return file_data_to_string(item.value)


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


def _check_available(pid: str, check: str, suite: str | None, case_data: dict) -> bool:
    """Availability is a local, code-checked prerequisite, not an LLM guess."""
    if check in ("site_structures", "look_from_above", "compare_captures", "lot_activity"):
        aerial = layers.FIXTURES / "vexcel" / f"{pid}.json"
        if not aerial.is_file():
            return False
        if check == "site_structures":
            return True
        if check == "look_from_above":
            return (vision.CACHE / f"{pid}_ortho_latest.jpg").is_file() and bool(
                list(vision.CACHE.glob(f"{pid}_oblique_*.jpg")))
        if check == "lot_activity":
            return (vision.CACHE / f"{pid}_cars.json").is_file()
        try:
            data = json.loads(aerial.read_text())
            history = sorted(data.get("footprint_history") or [], key=lambda h: h.get("date") or "")
            return len(history) >= 2 and all(
                (vision.CACHE / f"{pid}_ortho_{capture['collection']}.jpg").is_file()
                for capture in (history[0], history[-1]))
        except (OSError, ValueError, KeyError, TypeError):
            return False
    if check == "suite_tour":  # available when the suite's tour panoramas are cached (open_case carries no tour field)
        if not suite:
            return False
        from app.tenants import norm_suite

        normalized = norm_suite(suite)
        return bool(normalized and list(vision.CACHE.glob(f"{pid}_s{normalized}_p*_f*.jpg")))
    return True


def _hints(pid: str, case_data: dict, suite: str | None, stats: dict,
           worked_before: set[str] | None = None) -> list[dict]:
    case = case_data["case"]
    out = []
    for spec in case_data.get("checks", []):
        check = spec["check"]
        measured = stats.get(case, {}).get(check)
        if measured is None:  # team testimony is case-specific, not a queue statistic
            if check != "human_report":
                continue
            measured = {"cases": 0, "moved_cases": 0, "move_rate": 0.0,
                        "typical_move": evidence.HUMAN_CAP, "expected_move": 0.0}
            moved = "team report; not included in queue statistics"
        else:
            moved = (f"{round(measured['move_rate'] * 100)}% of the {measured['cases']} cases where it could run"
                     if measured["cases"] else "no cached examples")
        out.append({"check": check, "looks_at": evidence.CHECK_WHAT[check], "moved_odds_in": moved,
                    "typical_move": measured["typical_move"], "expected_move": measured["expected_move"],
                    "available": _check_available(pid, check, suite, case_data)})
        if worked_before is not None:
            out[-1]["worked_here_before"] = check in worked_before
    return sorted(out, key=lambda h: (-h["expected_move"], h["check"]))


async def _worked_before(runtime: ToolRuntime, pid: str) -> set[str]:
    if not _flag("RADAR_NIGHT_LOG"):
        return set()
    building = fortress.building(pid)
    if not building:
        return set()
    text = await _night_log_text(runtime)
    found: set[str] = set()
    for line in text.splitlines():
        if building["label"] not in line or "checks=" not in line:
            continue
        value = line.split("checks=", 1)[1].split(";", 1)[0]
        found.update(check for check in value.split(",") if check in evidence.CHECKS)
    return found


@tool
async def open_case(property_id: str, runtime: ToolRuntime, suite: str | None = None) -> dict:
    """Open a Last Stand case and show code-measured hints for the checks available here."""
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
    worked = await _worked_before(runtime, property_id) if _flag("RADAR_NIGHT_LOG") else None

    def attach() -> None:  # _hints globs the image cache: off the event loop (langgraph dev rejects blocking I/O there)
        for case_data in out.get("cases", []):
            case_data["check_hints"] = _hints(property_id, case_data, suite, stats, worked)
    await asyncio.to_thread(attach)
    return out


@tool
async def run_check(property_id: str, case: str, check: str, why: str, runtime: ToolRuntime,
                    suite: str | None = None) -> dict:
    """Run one advertised check; why is one radio line quoting its code-measured hint."""
    if bad := await _outside(property_id):
        return bad
    if check not in evidence.CHECKS:  # never run (or let the model narrate) a check that doesn't exist
        return {"error": f"'{check}' is not a check. Choose one from this case's check_hints in open_case.",
                "valid_checks": sorted(evidence.CHECKS)}
    notes = await _notes(runtime, property_id, suite)
    result = await asyncio.to_thread(evidence.run_check, property_id, check, case, suite, notes)
    result["selection_reason"] = " ".join(why.split())[:240]
    return result


@tool
async def weigh_case(property_id: str, case: str, checks: list[str], runtime: ToolRuntime,
                     suite: str | None = None) -> dict:
    """Weigh tonight's selected checks with code; stores the code-built trail for the optional dawn critic."""
    if bad := await _outside(property_id):
        return bad
    notes = await _notes(runtime, property_id, suite)
    result = await asyncio.to_thread(evidence.weigh_case, property_id, case, checks, suite, notes)
    await _remember_case(runtime, property_id, suite, result)
    return result


@tool
async def case_file(property_id: str, runtime: ToolRuntime, suite: str | None = None) -> dict:
    """The code-built checks, findings, effects, posterior and verdict for a case opened tonight."""
    if bad := await _outside(property_id):
        return bad
    if not getattr(runtime, "store", None) or not _thread_id(runtime):
        return {"status": "not_reviewed", "reason": "no case store"}
    item = await runtime.store.aget(("laststand_cases", _thread_id(runtime)), _case_key(property_id, suite))
    if not item:
        return {"status": "not_reviewed", "reason": "no code-built case file"}
    data = item.value
    return {key: data.get(key) for key in ("case", "checks_used", "trail", "posterior", "verdict")}


def _payload(content: Any) -> dict | None:
    if isinstance(content, dict):
        return content
    if isinstance(content, str):
        try:
            value = json.loads(content)
            return value if isinstance(value, dict) else None
        except ValueError:
            return None
    return None


def _night_summary(runtime: ToolRuntime) -> list[str]:
    messages = (getattr(runtime, "state", None) or {}).get("messages", [])
    calls: dict[str, tuple[str, dict]] = {}
    for message in messages:
        if isinstance(message, AIMessage):
            for call in message.tool_calls or []:
                calls[call.get("id")] = (call.get("name", ""), call.get("args") or {})
    latest_cases: dict[str, dict] = {}
    waves: list[str] = []
    for message in messages:
        if not isinstance(message, ToolMessage):
            continue
        name, args = calls.get(message.tool_call_id, (message.name or "", {}))
        data = _payload(message.content)
        if not data:
            continue
        if name == "weigh_case":
            pid = str(data.get("property_id") or args.get("property_id") or "")
            suite = data.get("suite") or args.get("suite")
            building = fortress.building(pid)
            if not building:
                continue
            trail = data.get("trail") or []
            checks = [t.get("check") for t in trail if t.get("check") in evidence.CHECKS]
            scored = [(max((abs(float(e.get("delta", 0))) for e in t.get("effects", [])), default=0.0), t.get("check"))
                      for t in trail]
            moved = max(scored, default=(0.0, None))[1]
            review = _critic_result(runtime, pid, suite) if _flag("RADAR_CRITIC") else None
            ref = _case_key(pid, suite)
            latest_cases[ref] = {"label": building["label"], "kind": "suite" if suite else "walls",
                                 "checks": checks, "moved": moved, "verdict": (data.get("verdict") or {}).get("label"),
                                 "review": ("not reviewed" if not review else ("follows" if review["follows"] else "flagged")),
                                 "player": "report recorded" if any(t.get("check") == "human_report" for t in trail) else None}
        elif name == "commit_plan":
            pid = str(args.get("pid") or "")
            here = fortress.building(pid)
            final = fortress.building(str(data.get("pid_final") or ""))
            if not here:
                continue
            action = "RUN" if final and final.get("pid") != here.get("pid") else "HOLD"
            waves.append(f"- wave {data.get('wave', args.get('wave', 1))}: {action} at {here['label']}; outcome={'held' if data.get('held') else 'breached'}")
    lines = []
    for info in latest_cases.values():
        checks = ",".join(info["checks"]) or "none"
        line = (f"- {info['kind']} {info['label']}; checks={checks}; lead_move={info['moved'] or 'none'}; "
                f"verdict={info['verdict'] or 'unresolved'}; reviewer={info['review']}")
        if info["player"]:
            line += "; player report recorded"
        lines.append(line)
    return lines + waves


@tool
async def log_night(runtime: ToolRuntime, lesson: str = "") -> dict:
    """Write this night’s code-built facts and one short lesson to the isolated Last Stand log."""
    if not getattr(runtime, "store", None):
        return {"status": "not_saved", "reason": "no persistent store"}
    facts = _night_summary(runtime)
    now = date.today().isoformat()
    previous = await _night_log_text(runtime)
    old_nights = [part.strip() for part in re.split(r"(?m)(?=^## Night )", previous) if part.strip()]
    body = [f"## Night {now}", *(facts or ["- no completed case or wave facts available"])]
    lesson = " ".join(lesson.split())
    number_tokens = set(re.findall(r"\d+(?:\.\d+)?", lesson))
    known_numbers = set(re.findall(r"\d+(?:\.\d+)?", "\n".join(body)))
    lesson_ok = len(lesson.split()) <= 20 and number_tokens <= known_numbers
    if lesson and lesson_ok:
        body.append(f"Lesson: {lesson}")
    current = "\n".join(body)
    nights = (old_nights + [current])[-3:]
    while len("\n\n".join(nights).encode("utf-8")) > 1024 and len(nights) > 1:
        nights.pop(0)
    if len("\n\n".join(nights).encode("utf-8")) > 1024:
        # Preserve the latest facts but drop optional detail before writing.
        compact = [f"## Night {now}"] + [line[:180] for line in facts[:3]]
        if lesson and lesson_ok:
            compact.append(f"Lesson: {lesson[:160]}")
        nights = ["\n".join(compact)]
    text = "\n\n".join(nights)
    from deepagents.backends.utils import create_file_data

    await runtime.store.aput(("laststand_log",), "/latest.md", create_file_data(text))
    return {"status": "saved", "nights_kept": len(nights), "bytes": len(text.encode("utf-8")),
            "lesson_saved": bool(lesson and lesson_ok),
            **({"lesson_status": "rejected: max 20 words or contains a number not in this log"} if lesson and not lesson_ok else {})}


def _json_value(text: Any) -> Any:
    if not isinstance(text, str):
        return text
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        match = re.search(r"\{[^{}]*\"follows\"\s*:\s*(?:true|false)[^{}]*\}", text, re.I | re.S)
        if not match:
            return None
        try:
            return json.loads(match.group(0))
        except ValueError:
            return None


def _find_critic_value(value: Any) -> dict | None:
    value = _json_value(value)
    if isinstance(value, dict):
        if all(k in value for k in ("follows", "weakest_link", "why")):
            return value
        for child in value.values():
            found = _find_critic_value(child)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = _find_critic_value(child)
            if found:
                return found
    return None


def _critic_result(runtime: ToolRuntime, pid: str, suite: str | None) -> dict | None:
    marker = f"case_ref={_case_key(pid, suite)}"
    calls = {}
    for message in (getattr(runtime, "state", None) or {}).get("messages", []):
        if isinstance(message, AIMessage):
            for call in message.tool_calls or []:
                args = call.get("args") or {}
                if call.get("name") == "task" and marker in json.dumps(args, sort_keys=True, default=str):
                    calls[call.get("id")] = args
    for message in reversed((getattr(runtime, "state", None) or {}).get("messages", [])):
        if not isinstance(message, ToolMessage) or message.tool_call_id not in calls:
            continue
        raw = message.content if isinstance(message.content, str) else json.dumps(message.content, default=str)
        answer = _find_critic_value(raw)
        if (answer and isinstance(answer.get("follows"), bool)
                and isinstance(answer.get("weakest_link"), str) and isinstance(answer.get("why"), str)
                and len(answer["why"].split()) <= 25):
            return answer
    return None


def _apply_critic(draft: dict, review: dict | None) -> dict:
    if review is None:
        draft["critic"] = {"status": "not reviewed"}
        return draft
    draft["critic"] = {"status": "reviewed", **review}
    if review["follows"] is False:
        draft["label_verdict"] = "unresolved"
        draft["text"] = f"A reviewer flagged: {review['why']}\n{draft['text']}"
    return draft


def _wave_and_checks(runtime: ToolRuntime, pid: str, suite: str | None = None) -> tuple[int, list[str]]:
    """The latest wave asked about and the checks run on pid (and suite), read from this thread's own tool calls."""
    from app.tenants import norm_suite

    wave, checks, su = 1, [], norm_suite(suite) if suite else None
    for m in (getattr(runtime, "state", None) or {}).get("messages", []):
        for c in getattr(m, "tool_calls", None) or [] if isinstance(m, AIMessage) else []:
            args = c.get("args") or {}
            if c.get("name") == "horde_status" and isinstance(args.get("wave"), int):
                wave = args["wave"]
            if c.get("name") in ("check_evidence", "run_check") and str(args.get("property_id")) == str(pid) \
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
    draft = await asyncio.to_thread(fortress.draft, property_id, suite, checks, notes)
    if _flag("RADAR_CRITIC"):
        return _apply_critic(draft, _critic_result(runtime, property_id, suite))
    return draft


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


GAME_TOOLS = [night_cases, fortress_dossier, horde_status, find_fallback, commit_plan, draft_correction, open_case, run_check, weigh_case, record_note]


def _enabled_tools() -> list:
    tools = list(GAME_TOOLS)
    if _flag("RADAR_NIGHT_LOG"):
        tools.append(log_night)
    return tools


def _enabled_subagents(m) -> list[dict]:
    specs = _specialists(True, m)
    if not _flag("RADAR_CRITIC"):
        return specs
    timeout = float(os.environ.get("RADAR_MODEL_TIMEOUT_S", "8")) or 8.0
    attempts = 1
    critic_name = os.environ.get("RADAR_CRITIC_MODEL", "gemini-4-argon")
    critic = make_model(critic_name, "low", timeout=timeout, attempts=attempts)
    fallback = make_model("gemini-3.8-flash", "low", timeout=timeout, attempts=1)
    specs.append({"name": "critic", "description": "Reviews whether one case's code-built evidence supports its verdict.",
                  "system_prompt": CRITIC_PROMPT, "tools": [case_file], "model": critic,
                  "response_format": CriticOut, "middleware": [_errors(), ModelFallbackMiddleware(fallback)]})
    return specs


def _enabled_prompt() -> str:
    prompt = GAME_PROMPT
    if not (_flag("RADAR_CRITIC") or _flag("RADAR_NIGHT_LOG")):
        return prompt
    additions = ["\n\nEnabled Last Stand upgrades (these replace the matching briefing/debrief steps above):"]
    if _flag("RADAR_NIGHT_LOG"):
        additions.append("""- At briefing, call read_file(\"/night_log/latest.md\") in the same message as night_cases(). If it exists,
  use its last lesson in the first radio line. Do not infer facts beyond the log.
- After all draft_correction calls have returned at dawn, call log_night exactly once. Give one lesson line of at most
  20 words; use no number unless it appears in the code-built facts. Never include company names or free-form reports.""")
    if _flag("RADAR_CRITIC"):
        additions.append("""- At dawn, before draft_correction, call task once per case opened tonight, in parallel. Assign each to critic and
  include the exact case_ref=<property_id>:<normalized-suite-or-dash> marker. Tell the critic to call case_file for that
  case and return CriticOut. Do not ask it to read your narrative. Then call draft_correction for each case; code applies
  a false review only by lowering the verdict label to unresolved.""")
    additions.append("- When both upgrades are on, run critic tasks first, drafts second, log_night third, then give the radio debrief.")
    return prompt + "\n".join(additions)

GAME_PROMPT = """You are the squad commander in Last Stand LA, a night shift on real downtown Los Angeles buildings. The
goal: settle tonight's cases and make it to dawn. The buildings, the records and the cases are real: they come from the
same queue a CoStar researcher works. You talk like a calm radio operator: short lines, no fluff. Every number you say comes from a tool
result; never compute or invent one.

Messages on this channel, in the order a night usually runs:

1. "Brief the night shift"
   Call night_cases(). Next message: write_todos with one item per case it returns (e.g. "Case #7: suite 1100, 122 7th
   St: is the tenant still there?") plus "Survive the night". Then answer in at most 3 radio lines: how many open cases
   the queue holds and how many are in our blocks (total, in_area), and tonight's cases with their stakes. No other tools.

2. "Check suite <suite> at building <pid>: is the tenant on record still there?"
   Call open_case(property_id=<pid>, suite=<suite>). Next message: choose the two available checks with the highest
   expected_move in check_hints and call run_check for both in parallel, passing suite. Each why is one short line that
   quotes that hint's moved_odds_in and typical_move. Then call weigh_case(property_id, case="ghost_tenant", checks,
   suite). If the leader is still under 50% and another check is available, run the next-highest hint and weigh again.
   Answer in at most 4 lines with the final verdict.text word for word.

3. "Tip: I'm inside suite <suite>. ..."  (a report about the suite case)
   Call record_note(property_id=<that building>, suite=<suite>, note=<the report>, source="the player", supports=
   <gone_dark if they say it is empty | still_there if people are working there | omit if they can't tell>). Next message:
   weigh_case for the ghost_tenant case with the checks you ran before plus human_report (pass suite). Answer in 2 lines:
   how the odds moved (from the tool) and that a person's report is strong but capped, never final.

4. "Scout property <pid>"
   In ONE message, call all of these together: write_todos (3-4 short mission objectives), task for each of the four
   squads (records, aerial, interior, civic; give each the property id), fortress_dossier(pid) and open_case(pid).
   If open_case returns a material_conflict, next message: choose the two available checks with the highest expected_move
   in check_hints and call run_check for both in parallel. Each why is one short line quoting that hint's moved_odds_in
   and typical_move. Then weigh_case with those checks. If the leader is still under 50% and another check is available,
   run the next-highest hint and weigh again. Then answer with at most 5 radio lines: what each squad found, the
   walls/quake/roof scores, and the final verdict using verdict.text word for word. If there is no case, skip the checks.

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
    backend = (CompositeBackend(default=StateBackend(), routes={
        "/night_log/": StoreBackend(namespace=lambda _rt: ("laststand_log",))})
        if _flag("RADAR_NIGHT_LOG") else StateBackend())
    return create_deep_agent(
        model=m.orch,
        tools=_enabled_tools(),
        system_prompt=_enabled_prompt(),
        middleware=[todos, _errors(), RetryBlank("Static on the line. Say again?"), ForceCommitPlan(),
                    ModelFallbackMiddleware(*m.orch_fallbacks)],
        subagents=_enabled_subagents(m),
        # Its own scratch space only: the auditor's memories and worklog (other buildings) stay out of the game.
        # Player tips still go to the shared Store through record_note.
        backend=backend,
        interrupt_on={"commit_plan": {"allowed_decisions": ["approve", "edit", "reject"]}},
        store=store,
        checkpointer=checkpointer,
        name="laststand",
    )


def _warm() -> None:
    """Precompute the district and every fortress card at startup, so the first click is instant (code only)."""
    try:
        evidence.check_stats()
    except Exception:  # no CoStar/public data on this machine; the game computes per case later
        pass
    try:
        for b in fortress.district()["buildings"]:
            fortress.dossier(b["pid"])
    except Exception:  # no kit on this machine (tests, CI): the routes compute on demand instead
        pass
    for warm in (fortress.city, fortress.solar, fortress.stale, lambda: fortress.suites("254167"), lambda: fortress.suites("249218")):
        try:  # side-mission data (HTTP only): first clicks at the table should be instant
            warm()
        except Exception:
            pass


game_agent = build()
threading.Thread(target=_warm, name="laststand-warm", daemon=True).start()

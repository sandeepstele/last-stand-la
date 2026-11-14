"""Play scripted Last Stand nights against a running agent server: to record the game replay, or to verify it.

  # record (server started with RADAR_REPLAY=record:game; seed fixtures/replay/game.json from demo.json first)
  uv run python scripts/game_nights.py
  # verify (server started with RADAR_REPLAY=game RADAR_REPLAY_STRICT=1 ... --no-reload), then grep its log for "replay miss"
  uv run python scripts/game_nights.py --tips concrete --actions run hold

Each night runs on a fresh thread in the night-shift order: "Brief the night shift" -> the suite case (#7, 254167 suite
1100) -> a report from inside the suite -> "Scout property 6375735" (#6) -> a walls report -> "Wave 1 is coming from the
W" -> HOLD or RUN. Replay keys depend only on the steps since each message, so 6 nights (suite reports cycled) cover
every recorded combination. The scripted resume stands in for the player's H/R keys on a test
thread (the game's commit_plan only rolls dice in code; nothing leaves the machine). demo_reset runs between nights.
These strings must match web/src/game exactly (docs/game/CONTRACT.md); re-record if the prompt, tools, strings or seed change.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
import time
from pathlib import Path

from langgraph_sdk import get_client

ROOT = Path(__file__).resolve().parent.parent
HERO, FALLBACK = "6375735", "9629605"
BRIEF = "Brief the night shift"
SUITE_Q = "Check suite 1100 at building 254167: is the tenant on record still there?"
SUITE_TIPS = {"empty": "Tip: I'm inside suite 1100. It's empty: no one is working here.",
              "people": "Tip: I'm inside suite 1100. People are working here.",
              "cant_tell": "Tip: I'm inside suite 1100. I can't tell if anyone works here."}
SCOUT = f"Scout property {HERO}"
DEBRIEF = "Debrief the night shift"
BRIDGE = f"Check building {HERO}."  # the auditor's own phrasing (scripts/demo_flow.py)
WAVE = "Wave 1 is coming from the W"
TIPS = {"concrete": "Tip: I'm inside the building. The walls and columns look like concrete.",
        "brick": "Tip: I'm inside the building. The walls look like brick.",
        "cant_tell": "Tip: I'm inside the building. I can't tell what the walls are made of."}


def _text(content) -> str:
    if isinstance(content, str):
        return content
    return " ".join(b.get("text", "") for b in content if isinstance(b, dict))


async def _run(c, tid: str, label: str, graph: str = "laststand", **kw):
    t0, interrupt, answer = time.time(), None, ""
    async for ch in c.runs.stream(tid, graph, stream_mode="updates", **kw):
        if ch.event != "updates" or not isinstance(ch.data, dict):
            continue
        for node, upd in ch.data.items():
            if node == "__interrupt__":
                interrupt = upd
                continue
            for m in (upd or {}).get("messages", []) if isinstance(upd, dict) else []:
                if m.get("type") == "ai" and m.get("content") and not m.get("tool_calls"):
                    answer = _text(m["content"])
    print(f"  {label:<22} {time.time() - t0:5.1f}s  {answer.replace(chr(10), ' / ')[:150]}")
    return interrupt


def _decision(proposed: dict, want: str) -> dict:
    if proposed.get("action") == want:
        return {"type": "approve"}
    args = {"pid": HERO, "action": want, "to_pid": FALLBACK if want == "run" else None}
    return {"type": "edit", "edited_action": {"name": "commit_plan", "args": args}}


async def night(c, tip: str, want: str, suite_tip: str | None, stage: bool = False) -> None:
    print(f"night: {'STAGE ' if stage else ''}suite {'(worked from data, no tip)' if stage else suite_tip} / walls {tip} + {want}")
    tid = (await c.threads.create())["thread_id"]
    t_start = time.time()
    steps = (("brief", BRIEF), ("suite case", SUITE_Q)) if stage else \
        (("brief", BRIEF), ("suite case", SUITE_Q), ("suite tip", SUITE_TIPS[suite_tip])) if suite_tip else ()
    for label, text in steps:
        await _run(c, tid, label, input={"messages": [{"role": "user", "content": text}]})
    await _run(c, tid, "scout", input={"messages": [{"role": "user", "content": SCOUT}]})
    t_scout = time.time()
    await _run(c, tid, "tip", input={"messages": [{"role": "user", "content": TIPS[tip]}]})
    print(f"  {'(from first message)':<22} scout done at {t_scout - t_start:.1f}s, tip done at {time.time() - t_start:.1f}s")
    intr = await _run(c, tid, "wave", input={"messages": [{"role": "user", "content": WAVE}]})
    if not intr:
        print("  !! no HOLD/RUN interrupt")
        return
    d = _decision(intr[0]["value"]["action_requests"][0]["args"], want)
    await _run(c, tid, f"{want} ({d['type']})", command={"resume": {"decisions": [d]}})
    await _run(c, tid, "debrief", input={"messages": [{"role": "user", "content": DEBRIEF}]})
    if stage:  # dawn flips to the auditor: the same question its own page asks, on a fresh radar thread
        aid = (await c.threads.create())["thread_id"]
        await _run(c, aid, "auditor bridge", graph="radar", input={"messages": [{"role": "user", "content": BRIDGE}]})


async def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="http://127.0.0.1:2024")
    p.add_argument("--tips", nargs="+", choices=list(TIPS), default=list(TIPS))
    p.add_argument("--actions", nargs="+", choices=["run", "hold"], default=["run", "hold"])
    p.add_argument("--no-suite", action="store_true", help="skip the briefing and suite case (the #6-only night)")
    p.add_argument("--suites", nargs="+", choices=list(SUITE_TIPS), help="every suite tip x walls tip x action "
                   "(default: cycle the suite tips across the nights)")
    p.add_argument("--stage", action="store_true", help="the ?demo=1 stage cut: brief, suite case worked from data (no "
                   "suite tip), #6, then the auditor's 'Check building 6375735.'")
    a = p.parse_args()
    c = get_client(url=a.url)
    print("server:", json.dumps({k: v for k, v in (await c.http.get("/healthz")).items() if k == "replay"}))
    cycle = list(SUITE_TIPS)
    plan = [(su, t, w) for su in a.suites for t in a.tips for w in a.actions] if a.suites else \
        [(None if a.no_suite else cycle[i % len(cycle)], t, w) for i, (t, w) in enumerate((t, w) for t in a.tips for w in a.actions)]
    for suite_tip, tip, want in plan:
        subprocess.run([sys.executable, str(ROOT / "scripts" / "demo_reset.py"), "--url", a.url], check=True, capture_output=True)
        await night(c, tip, want, suite_tip, stage=a.stage)


if __name__ == "__main__":
    asyncio.run(main())

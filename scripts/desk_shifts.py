"""Play scripted Bob's Desk shifts against a running agent server: to record the desk replay, or to verify it.

  # record/fill (server started with RADAR_REPLAY=fill:stage RADAR_MODEL_TIMEOUT_S=20 ... --no-reload)
  .venv/bin/python scripts/desk_shifts.py --stage
  .venv/bin/python scripts/desk_shifts.py --tips concrete brick cant_tell --tags approve red
  # verify (RADAR_REPLAY=stage RADAR_REPLAY_STRICT=1), then grep the server log for "replay miss"

Each shift runs on a fresh thread in shift order: "Start Bob's shift" -> the suite case (#7, 254167 suite 1100) [-> a
report from inside the suite] -> "Inspect building 6375735" (#6) -> a walls report -> "Quake at 5:02 pm. Tag building
6375735" -> Bob's tag (approve the proposal, or change it) -> "End the shift". demo_reset runs between shifts. These
strings must match web/src/game exactly; re-record if the prompt, tools, strings or seed change.
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

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from game_nights import SUITE_Q, SUITE_TIPS, TIPS, _text  # noqa: E402  the same player strings as the night game

ROOT = Path(__file__).resolve().parent.parent
HERO = "6375735"
START = "Start Bob's shift"
INSPECT = f"Inspect building {HERO}"
QUAKE = f"Quake at 5:02 pm. Tag building {HERO}"
END = "End the shift"
# A reject carries this exact message (the frontend sends the same): without one, the interrupt writes a reply with a
# fresh random call id, which no recording can match.
REJECT = "Bob declined to tag this building."
GRAPH = "desk"


async def _run(c, tid: str, label: str, **kw):
    t0, interrupt, answer, tools = time.time(), None, "", []
    async for ch in c.runs.stream(tid, GRAPH, stream_mode="updates", **kw):
        if ch.event == "error":
            print(f"  !! {label}: {str(ch.data)[:200]}")
        if ch.event != "updates" or not isinstance(ch.data, dict):
            continue
        for node, upd in ch.data.items():
            if node == "__interrupt__":
                interrupt = upd
                continue
            for m in (upd or {}).get("messages", []) if isinstance(upd, dict) else []:
                if m.get("type") == "ai":
                    tools += [t.get("name") for t in m.get("tool_calls") or []]
                    if m.get("content") and not m.get("tool_calls"):
                        answer = _text(m["content"])
    print(f"  {label:<18} {time.time() - t0:5.1f}s  tools={','.join(tools)[:90]}\n  {'':<18}        {answer.replace(chr(10), ' / ')[:260]}")
    return interrupt


def _decision(proposed: dict, want: str) -> dict:
    if want == "reject":
        return {"type": "reject", "message": REJECT}
    if want == "approve" or proposed.get("tag") == want:
        return {"type": "approve"}
    return {"type": "edit", "edited_action": {"name": "tag_building", "args": {"pid": HERO, "tag": want}}}


async def shift(c, tip: str, want: str, suite_tip: str | None, stage: bool = False, day: int = 1) -> None:
    global HERO
    from app.desk import DAYS

    d = DAYS[day - 1]
    HERO = d["hero_pid"]
    start = START if day == 1 else f"{START}, day {day}"
    suite_q = SUITE_Q if day == 1 else f"Check suite {d['suite']} at building {d['office_pid']}: is the tenant on record still there?"
    suite_tips = SUITE_TIPS if day == 1 else {k: v.replace("suite 1100", f"suite {d['suite']}") for k, v in SUITE_TIPS.items()}
    print(f"shift: day {day} {'STAGE ' if stage else ''}suite {'(from data)' if stage else suite_tip} / walls {tip} / tag {want}")
    tid = (await c.threads.create())["thread_id"]
    steps = [("start", start), ("suite case", suite_q)] + ([("suite tip", suite_tips[suite_tip])] if suite_tip and not stage else [])
    for label, text in steps + [("inspect", f"Inspect building {HERO}"), ("walls tip", TIPS[tip])]:
        await _run(c, tid, label, input={"messages": [{"role": "user", "content": text}]})
    intr = await _run(c, tid, "quake", input={"messages": [{"role": "user", "content": f"Quake at 5:02 pm. Tag building {HERO}"}]})
    if not intr:
        print("  !! no tag interrupt")
        return
    proposed = intr[0]["value"]["action_requests"][0]["args"]
    d = _decision(proposed, want)
    await _run(c, tid, f"tag {proposed.get('tag')}->{want}", command={"resume": {"decisions": [d]}})
    await _run(c, tid, "end", input={"messages": [{"role": "user", "content": END}]})
    print(f"  thread {tid}")


async def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="http://127.0.0.1:2024")
    p.add_argument("--tips", nargs="+", choices=list(TIPS), default=["concrete"])
    p.add_argument("--tags", nargs="+", choices=["approve", "green", "yellow", "red", "reject"], default=["approve"])
    p.add_argument("--suites", nargs="+", choices=list(SUITE_TIPS), default=None,
                   help="suite tips to cycle across shifts (default: cycle all three)")
    p.add_argument("--stage", action="store_true", help="the ?demo=1 cut: the suite case is worked from data (no suite tip)")
    p.add_argument("--days", nargs="+", type=int, default=[1], help="days to play in order on fresh threads, WITHOUT a "
                   "reset between them (a career: each day's briefing reads the previous day's log); day 1 resets first")
    a = p.parse_args()
    c = get_client(url=a.url)
    print("server:", json.dumps({k: v for k, v in (await c.http.get("/healthz")).items() if k == "replay"}))
    cycle = a.suites or list(SUITE_TIPS)
    plan = [(t, w) for t in a.tips for w in a.tags]
    for i, (tip, want) in enumerate(plan):
        for day in a.days:
            if day == a.days[0]:
                subprocess.run([sys.executable, str(ROOT / "scripts" / "demo_reset.py"), "--url", a.url], check=True,
                               capture_output=True)
            await shift(c, tip, want, None if a.stage else cycle[i % len(cycle)], stage=a.stage, day=day)


if __name__ == "__main__":
    asyncio.run(main())

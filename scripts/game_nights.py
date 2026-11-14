"""Play scripted Last Stand nights against a running agent server: to record the game replay, or to verify it.

  # record (server started with RADAR_REPLAY=record:game; seed fixtures/replay/game.json from demo.json first)
  uv run python scripts/game_nights.py
  # verify (server started with RADAR_REPLAY=game RADAR_REPLAY_STRICT=1 ... --no-reload), then grep its log for "replay miss"
  uv run python scripts/game_nights.py --tips concrete --actions run hold

Each night runs on a fresh thread in the on-foot order: "Scout property 6375735" -> a tip from inside the building ->
"Wave 1 is coming from the W" -> HOLD or RUN. The scripted resume stands in for the player's H/R keys on a test
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
SCOUT = f"Scout property {HERO}"
WAVE = "Wave 1 is coming from the W"
TIPS = {"concrete": "Tip: I'm inside the building. The walls and columns look like concrete.",
        "brick": "Tip: I'm inside the building. The walls look like brick.",
        "cant_tell": "Tip: I'm inside the building. I can't tell what the walls are made of."}


def _text(content) -> str:
    if isinstance(content, str):
        return content
    return " ".join(b.get("text", "") for b in content if isinstance(b, dict))


async def _run(c, tid: str, label: str, **kw):
    t0, interrupt, answer = time.time(), None, ""
    async for ch in c.runs.stream(tid, "laststand", stream_mode="updates", **kw):
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


async def night(c, tip: str, want: str) -> None:
    print(f"night: {tip} + {want}")
    tid = (await c.threads.create())["thread_id"]
    await _run(c, tid, "scout", input={"messages": [{"role": "user", "content": SCOUT}]})
    await _run(c, tid, "tip", input={"messages": [{"role": "user", "content": TIPS[tip]}]})
    intr = await _run(c, tid, "wave", input={"messages": [{"role": "user", "content": WAVE}]})
    if not intr:
        print("  !! no HOLD/RUN interrupt")
        return
    d = _decision(intr[0]["value"]["action_requests"][0]["args"], want)
    await _run(c, tid, f"{want} ({d['type']})", command={"resume": {"decisions": [d]}})


async def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="http://127.0.0.1:2024")
    p.add_argument("--tips", nargs="+", choices=list(TIPS), default=list(TIPS))
    p.add_argument("--actions", nargs="+", choices=["run", "hold"], default=["run", "hold"])
    a = p.parse_args()
    c = get_client(url=a.url)
    print("server:", json.dumps({k: v for k, v in (await c.http.get("/healthz")).items() if k == "replay"}))
    for tip in a.tips:
        for want in a.actions:
            subprocess.run([sys.executable, str(ROOT / "scripts" / "demo_reset.py"), "--url", a.url], check=True, capture_output=True)
            await night(c, tip, want)


if __name__ == "__main__":
    asyncio.run(main())

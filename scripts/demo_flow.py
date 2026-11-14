"""Run the demo flow end to end against the agent server and print a timing / verdict table.

  python scripts/demo_flow.py            # reset, then the full flow once
  python scripts/demo_flow.py --runs 5   # five clean passes (reset before each)

Uses the exact questions the UI sends (queue clicks) and the exact framing the iMessage bridge adds to a
texted correction, so a recording made with RADAR_REPLAY=record:demo replays the same flow.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

from langgraph_sdk import get_sync_client

ROOT = Path(__file__).resolve().parent.parent
FRAME = ("Text from the owner over iMessage. Your final answer is texted back as is: at most three short sentences, "
         "plain text, no markdown, and do not call notify_me for this request.\n\n")
SUITE_Q = "Check suite {suite} at building {pid}: is the tenant on record still there?"
CORRECTION = "Correction: the property manager at building 247386 told me by phone today that the tenant in suite 300 is still there."

FLOW = [
    ("material conflict 247337", "radar", "Check building 247337."),
    ("ghost 247386#300", "radar", SUITE_Q.format(suite="300", pid="247386")),
    ("texted correction", "radar_worker", FRAME + CORRECTION),
    ("ghost 247386#300 after", "radar", SUITE_Q.format(suite="300", pid="247386")),
    ("ghost 240660#A", "radar", SUITE_Q.format(suite="A", pid="240660")),
    ("stale entry 11547997", "radar", "Check building 11547997."),
]


def run_once(client) -> list[dict]:
    rows = []
    for label, assistant, text in FLOW:
        t = time.time()
        cfg = {"configurable": {"channel": "imessage"}} if assistant == "radar_worker" else None
        v = client.runs.wait(None, assistant, input={"messages": [{"role": "user", "content": text}]}, config=cfg)
        secs = time.time() - t
        msgs = v.get("messages", []) if isinstance(v, dict) else []
        weigh = next((json.loads(m["content"]) for m in reversed(msgs) if m.get("type") == "tool" and m.get("name") == "weigh_case"), None)
        checks = [tc["args"].get("check") for m in msgs if m.get("type") == "ai" for tc in m.get("tool_calls") or [] if tc["name"] == "check_evidence"]
        notes = [tc["name"] for m in msgs if m.get("type") == "ai" for tc in m.get("tool_calls") or [] if tc["name"] == "record_note"]
        errors = [m.get("name") for m in msgs if m.get("type") == "tool" and str(m.get("content", "")).startswith("ERROR")]
        verdict = (f"{weigh['verdict']['label']} {weigh['verdict']['hypothesis']} {weigh['verdict']['confidence']}" if weigh
                   else ("note saved" if notes else "-"))
        rows.append({"step": label, "seconds": round(secs, 1), "checks": checks, "verdict": verdict,
                     "conflict": (weigh or {}).get("report_conflicts_with_records"), "tool_errors": errors})
    return rows


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--runs", type=int, default=1)
    p.add_argument("--url", default="http://127.0.0.1:2024")
    a = p.parse_args()
    client = get_sync_client(url=a.url, api_key=None)
    ok = True
    for i in range(a.runs):
        subprocess.run([sys.executable, str(ROOT / "scripts" / "demo_reset.py"), "--url", a.url], check=True, capture_output=True)
        rows = run_once(client)
        print(f"\n== pass {i + 1}")
        for r in rows:
            print(f"  {r['step']:28} {r['seconds']:6.1f}s  {r['verdict']:42} checks={','.join(c or '?' for c in r['checks'])}"
                  + (f"  conflict={r['conflict']}" if r["conflict"] is not None else "") + (f"  ERRORS={r['tool_errors']}" if r["tool_errors"] else ""))
        before, after = rows[1]["verdict"], rows[3]["verdict"]
        moved = before != after and rows[3]["conflict"]
        ok &= bool(moved) and all(not r["tool_errors"] for r in rows) and all(r["seconds"] < 60 for r in rows)
        print(f"  correction moved the case: {bool(moved)} ({before} -> {after})")
    print("\nALL CLEAN" if ok else "\nNOT CLEAN")


if __name__ == "__main__":
    main()

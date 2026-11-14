"""Run the agent locally (in-memory store + checkpointer) and stream what it does.

  python scripts/run_agent.py "Is TEST-A worth a solar and roof retrofit? City: houston."  (TEST-A is synthetic)
  python scripts/run_agent.py --graph worker "Screen TEST-A."

Scene verbs run in dispatch mode here (no frontend), so they send and return immediately. Traces go to the LangSmith project in .env.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")
os.environ.setdefault("RADAR_SCENE_MODE", "dispatch")  # no browser here: send scene actions, do not wait
os.environ["RADAR_MATTERPORT"] = os.environ.get("RADAR_MATTERPORT_RUN", "cached")

from langgraph.checkpoint.memory import InMemorySaver  # noqa: E402
from langgraph.store.memory import InMemoryStore  # noqa: E402

from app.agent import build  # noqa: E402


def _short(x, n=160) -> str:
    s = str(x).replace("\n", " ")
    return s if len(s) <= n else s[: n - 1] + "…"


async def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("question")
    p.add_argument("--graph", choices=["live", "worker"], default="live")
    a = p.parse_args()

    agent = build(a.graph, store=InMemoryStore(), checkpointer=InMemorySaver())
    run_id = uuid.uuid4()
    cfg = {"configurable": {"thread_id": str(uuid.uuid4())}, "recursion_limit": 80,
           "run_id": run_id, "run_name": f"radar-{a.graph} local test", "tags": ["local-test"]}
    t0 = time.time()
    final = None
    async for ns, chunk in agent.astream({"messages": [{"role": "user", "content": a.question}]},
                                         config=cfg, stream_mode="updates", subgraphs=True):
        where = "main" if not ns else ns[0].split(":")[0]
        for node, update in (chunk or {}).items():
            if node == "__interrupt__":
                print(f"[{time.time()-t0:5.1f}s] {where:10} INTERRUPT (needs approval): {_short(update)}")
                continue
            for m in (update or {}).get("messages", []) if isinstance(update, dict) else []:
                calls = getattr(m, "tool_calls", None)
                if calls:
                    for c in calls:
                        print(f"[{time.time()-t0:5.1f}s] {where:10} -> {c['name']}({_short(c['args'], 120)})")
                elif m.type == "tool":
                    print(f"[{time.time()-t0:5.1f}s] {where:10} <- {m.name}: {_short(m.content)}")
                elif m.type == "ai" and where == "main":
                    final = m
    print(f"\n=== FINAL ({time.time()-t0:.1f}s) ===")
    print(final.text if final is not None and hasattr(final, "text") else final)
    if os.environ.get("LANGSMITH_TRACING") == "true":
        from langchain_core.tracers.langchain import wait_for_all_tracers
        from langsmith import Client

        wait_for_all_tracers()
        try:
            print("trace:", Client().get_run_url(run=Client().read_run(run_id)))
        except Exception as e:  # trace may take a moment to land
            print("trace: (not available yet)", type(e).__name__)


if __name__ == "__main__":
    asyncio.run(main())

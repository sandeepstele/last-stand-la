"""Reset the demo between judges: everyone sees the same fresh story.

  python scripts/demo_reset.py            # clear team notes, decisions and outbox; keep every evidence cache
  python scripts/demo_reset.py --dry-run  # show what would be cleared

Clears, in the running agent server's Store (LANGGRAPH_URL, default http://127.0.0.1:2024):
  ("notes", <any building or suite>)   team notes / human reports, so a judge's correction moves the case live
  ("corrections",)                     Approve / Reject decisions on correction drafts
  ("outbox",)                          notify_me / send_outreach drafts
  paused background-worker threads           runs waiting at an approval (deleted, not decided), so the next
                                             sweep or text starts on a clean thread
  paused Last Stand threads                  game nights waiting at HOLD/RUN (deleted, not decided)
Keeps fixtures/ (Vexcel, Matterport, vision answers, public data), so the demo stays fast and offline.
Then re-warms the case queue.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from dotenv import load_dotenv
from langgraph_sdk import get_sync_client

ROOT = Path(__file__).resolve().parent.parent
import sys  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.night_log import LAST_STAND_LOG_SEED  # noqa: E402  (one seed for the script and Play again)


def reset_night_log(store, dry_run: bool = False) -> int:
    """Replace the game-only memory with the fixed, code-derived first-night seed."""
    items = store.search_items(["laststand_log"], limit=100)["items"]
    if not dry_run:
        for item in items:
            store.delete_item(item["namespace"], item["key"])
        from deepagents.backends.utils import create_file_data

        store.put_item(["laststand_log"], "/latest.md", create_file_data(LAST_STAND_LOG_SEED))
    return len(items)


def main() -> None:
    load_dotenv(ROOT / ".env")
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--keep-paused", action="store_true", help="leave runs waiting at an approval alone")
    p.add_argument("--url", default=os.environ.get("LANGGRAPH_URL", "http://127.0.0.1:2024"))
    a = p.parse_args()
    client = get_sync_client(url=a.url, api_key=None)
    cleared = {}
    for prefix in (["notes"], ["corrections"], ["outbox"]):
        n = 0
        while True:
            items = client.store.search_items(prefix, limit=100)["items"]
            if not items:
                break
            for it in items:
                n += 1
                if not a.dry_run:
                    client.store.delete_item(it["namespace"], it["key"])
            if a.dry_run:
                break
        cleared["/".join(prefix)] = n
    cleared["laststand_log"] = reset_night_log(client.store, a.dry_run)
    if not a.dry_run:  # Bob's Desk: the fixed previous shift (app/desk.py)
        from deepagents.backends.utils import create_file_data

        from app.desk import LOG_SEED as DESK_LOG_SEED

        for it in client.store.search_items(["desk_log"], limit=100)["items"]:
            client.store.delete_item(it["namespace"], it["key"])
        client.store.put_item(["desk_log"], "/latest.md", create_file_data(DESK_LOG_SEED))
    for graph, label in (("radar_worker", "paused worker threads"), ("laststand", "paused game threads"), ("desk", "paused desk threads")):
        paused = [] if a.keep_paused else client.threads.search(metadata={"graph_id": graph}, status="interrupted", limit=100)
        for t in paused:
            if not a.dry_run:
                client.threads.delete(t["thread_id"])
        cleared[label] = len(paused)
    print(("would clear and seed " if a.dry_run else "cleared and seeded ") + ", ".join(f"{k}: {v}" for k, v in cleared.items()))
    try:
        import httpx

        q = httpx.get(f"{a.url}/cases/queue", timeout=60).json()
        print(f"queue warm: {q['total']} cases {q['counts']}")
    except Exception as e:  # the reset itself already happened
        print(f"queue not warmed ({type(e).__name__}); is langgraph dev running?")


if __name__ == "__main__":
    main()

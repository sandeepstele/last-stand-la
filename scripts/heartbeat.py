"""The background worker's heartbeat.

  python scripts/heartbeat.py tick              # run one worker tick now (also the demo button)
  python scripts/heartbeat.py create            # hourly cron (the data is static this weekend)
  python scripts/heartbeat.py list
  python scripts/heartbeat.py delete            # delete ALL radar_worker crons (do this after judging)

Cron input must be explicit (a cron with no input fails with EmptyInputError). Runs keep their
threads (on_run_completed / on_completion = "keep") so the Inbox and LangSmith can list them.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402
from langgraph_sdk import get_sync_client  # noqa: E402

ASSISTANT = "radar_worker"
TICK = {"messages": [{"role": "user", "content": "Heartbeat tick: work the queue."}]}


def main() -> None:
    load_dotenv(ROOT / ".env")
    p = argparse.ArgumentParser()
    p.add_argument("action", choices=["tick", "create", "list", "delete"])
    p.add_argument("--url", default=os.environ.get("LANGGRAPH_URL", "http://127.0.0.1:2024"))
    p.add_argument("--schedule", default="0 * * * *", help="cron in UTC unless --timezone is given")
    p.add_argument("--timezone", default=None, help="IANA name, e.g. America/New_York")
    a = p.parse_args()
    client = get_sync_client(url=a.url, api_key=os.environ.get("LANGSMITH_API_KEY") if "127.0.0.1" not in a.url else None)

    if a.action == "tick":
        run = client.runs.create(None, ASSISTANT, input=TICK, on_completion="keep", metadata={"trigger": "manual-tick"})
        print("started", run["run_id"], "thread", run["thread_id"])
    elif a.action == "create":
        cron = client.crons.create(ASSISTANT, schedule=a.schedule, input=TICK, on_run_completed="keep",
                                   timezone=a.timezone, metadata={"trigger": "heartbeat"})
        print("cron", cron["cron_id"], a.schedule, a.timezone or "UTC")
    elif a.action == "list":
        for c in client.crons.search(assistant_id=ASSISTANT):
            print(c["cron_id"], c.get("schedule"), c.get("next_run_date"))
    else:
        for c in client.crons.search(assistant_id=ASSISTANT):
            client.crons.delete(c["cron_id"])
            print("deleted", c["cron_id"])


if __name__ == "__main__":
    main()

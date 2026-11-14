"""Seed the agent's Store with standing orders, skills and an initial worker queue.

  python scripts/seed_store.py                       # local `langgraph dev` on :2024
  python scripts/seed_store.py --url https://<deployment> --queue TEST-A,PROP-123

Keys follow deepagents' CompositeBackend layout (route prefix stripped):
  ("memories",) "/AGENTS.md"                     <- seed/memories/AGENTS.md
  ("skills",)   "/<skill>/SKILL.md"              <- seed/skills/<skill>/SKILL.md
  ("queue",)    "<property_id>" {task, status: queued, ...}
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from deepagents.backends.utils import create_file_data  # noqa: E402
from dotenv import load_dotenv  # noqa: E402
from langgraph_sdk import get_sync_client  # noqa: E402


def main() -> None:
    load_dotenv(ROOT / ".env")
    p = argparse.ArgumentParser()
    p.add_argument("--url", default=os.environ.get("LANGGRAPH_URL", "http://127.0.0.1:2024"))
    p.add_argument("--queue", default="", help="comma-separated property ids to queue for the worker")
    a = p.parse_args()

    client = get_sync_client(url=a.url, api_key=os.environ.get("LANGSMITH_API_KEY") if "127.0.0.1" not in a.url else None)
    agents_md = (ROOT / "seed/memories/AGENTS.md").read_text()
    client.store.put_item(["memories"], "/AGENTS.md", create_file_data(agents_md))
    print("seeded /memories/AGENTS.md")
    for skill in sorted((ROOT / "seed/skills").glob("*/SKILL.md")):
        key = f"/{skill.parent.name}/SKILL.md"
        client.store.put_item(["skills"], key, create_file_data(skill.read_text()))
        print(f"seeded /skills{key}")
    for pid in filter(None, (x.strip() for x in a.queue.split(","))):
        client.store.put_item(["queue"], pid, {"task": "screen", "status": "queued", "added_by": "seed",
                                               "added_at": datetime.now(UTC).isoformat()})
        print(f"queued {pid}")


if __name__ == "__main__":
    main()

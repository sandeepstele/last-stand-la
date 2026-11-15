"""Freeze the check statistics (app/evidence.check_stats) to fixtures/public/check_stats.json (gitignored).

  python scripts/freeze_stats.py   # snapshot what the cache says now; restart the server after

The hints the agent sees come from these stats, and recorded replay keys include them. Without a snapshot, any new cached
photo read (someone playing a new building) shifts them and the recorded demo drifts live. Delete the file, or set
RADAR_STATS_LIVE=1, to measure live again.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import evidence  # noqa: E402

out = evidence._measure_check_stats()
evidence.FROZEN_STATS.parent.mkdir(parents=True, exist_ok=True)
evidence.FROZEN_STATS.write_text(json.dumps(out, sort_keys=True))
print(f"froze {sum(len(v) for v in out.values())} check stats over {len(out)} case types -> {evidence.FROZEN_STATS}")

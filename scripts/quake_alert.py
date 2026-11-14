"""Fire the earthquake alert: a LABELED REPLAY of 1994 Northridge (USGS ci3144585) against today's portfolio.

  python scripts/quake_alert.py              # the bridge starts a radar_worker run on the owner's thread
  python scripts/quake_alert.py --event ci3144585

The worker ranks the LA buildings by replayed shaking, writes dossiers, drafts one gated outreach, and the
bridge texts the owner the result and the approval prompt; YES / NO by text resumes the run.
Needs the bridge (cd photon && npm start) and langgraph dev on :2024.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent

if __name__ == "__main__":
    load_dotenv(ROOT / ".env")
    p = argparse.ArgumentParser()
    p.add_argument("--event", default="ci3144585")
    a = p.parse_args()
    url = os.environ.get("PHOTON_BRIDGE_URL", "http://127.0.0.1:8787").rstrip("/") + "/trigger"
    r = httpx.post(url, json={"event_id": a.event}, timeout=10,
                   headers={"Authorization": f"Bearer {os.environ['PHOTON_BRIDGE_TOKEN']}"})
    print(r.status_code, r.json())

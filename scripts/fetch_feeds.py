"""Fetch display-only photos for the game's feeds into fixtures/vision/feed_* (gitignored; licensed imagery stays local).

  uv run python scripts/fetch_feeds.py              # LA buildings with an open case + every kit building in the play area
  uv run python scripts/fetch_feeds.py --limit 5    # a quick sample

For each building: a Vexcel top-down photo (feed_<pid>_ortho.jpg) and the newest oblique (feed_<pid>_oblique_<dir>.jpg),
framed from the CoStar coordinates (no Vexcel attribute fetch, so fixtures/vexcel and the evidence stay untouched);
for play-area buildings with a Matterport twin, the first panorama's six faces (feed_<pid>_twin_p0_f<k>.jpg, read-only).
The agent, the case queue and the evidence never read feed_ names, so this cannot change a recorded night.
"""

from __future__ import annotations

import argparse
import math
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")

from app import cases, costar, fortress, vision  # noqa: E402

FEED = vision.CACHE


def _aer(rec: dict) -> dict:
    floor = rec.get("typical_floor_sqft") or ((rec.get("gba_sqft") or 0) / (rec.get("stories") or 1)) or 8000
    return {"lat": rec["latitude"], "lon": rec["longitude"], "footprint_sqft": floor}


def photos(pid: str) -> str:
    rec = costar.get(pid)
    if not rec.get("latitude"):
        return "no coordinates"
    if list(FEED.glob(f"feed_{pid}_o*.jpg")):
        return "cached"
    aer = _aer(rec)
    with tempfile.TemporaryDirectory() as tmp:
        saved = vision.CACHE
        vision.CACHE = Path(tmp)  # vision.ortho/oblique write into CACHE: point them at a scratch dir, then rename
        try:
            got = []
            try:
                got.append(("ortho", vision.ortho(pid, aer)))
            except Exception as e:
                got.append(("ortho-error", str(e)[:80]))
            try:
                ob = vision.oblique(pid, aer)
                if ob:
                    got.append(("oblique", ob))
            except Exception as e:
                got.append(("oblique-error", str(e)[:80]))
        finally:
            vision.CACHE = saved
        names = []
        for kind, p in got:
            if isinstance(p, Path) and p.exists():
                name = f"feed_{pid}_ortho.jpg" if kind == "ortho" else f"feed_{pid}_{p.stem.split('_', 1)[1]}.jpg"
                shutil.copyfile(p, FEED / name)
                names.append(name)
        return ", ".join(names) or "; ".join(str(p) for k, p in got)


def twin(pid: str) -> str:
    import httpx

    from app import matterport

    if list(FEED.glob(f"feed_{pid}_twin_p0_f*.jpg")) or list(FEED.glob(f"{pid}_twin_p0_f*.jpg")):
        return "cached"
    models = costar.get(pid).get("matterport_model_ids") or []
    if not models:
        return "no twin"
    q = '{ model(id: "%s") { panoLocations { id skybox(resolution: "2k") { status children } } } }' % models[0]
    locs = matterport._post(q)["model"]["panoLocations"]
    faces = (locs[0].get("skybox") or {}).get("children") or [] if locs else []
    n = 0
    for k, url in enumerate(faces[:6]):
        r = httpx.get(url, timeout=60)
        if r.status_code == 200 and r.headers.get("content-type", "").startswith("image"):
            (FEED / f"feed_{pid}_twin_p0_f{k}.jpg").write_bytes(r.content)
            n += 1
    return f"{n} faces"


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--no-twins", action="store_true")
    a = p.parse_args()
    g, pad = fortress.GROUND, 80
    play = [b["pid"] for b in fortress.district()["buildings"]
            if g["x0"] - pad <= b["x"] <= g["x1"] + pad and g["z0"] - pad <= b["z"] <= g["z1"] + pad]
    la_cases = [b["pid"] for b in fortress.city()["buildings"] if b["case"]]
    targets = list(dict.fromkeys(play + la_cases))[: a.limit or None]
    print(f"{len(play)} play-area + {len(la_cases)} LA case buildings -> {len(targets)} to photograph", flush=True)
    for i, pid in enumerate(targets, 1):
        print(f"[{i}/{len(targets)}] {pid}: {photos(pid)}", flush=True)
        time.sleep(0.3)  # polite
    if not a.no_twins:
        for pid in play:
            try:
                print(f"twin {pid}: {twin(pid)}", flush=True)
            except Exception as e:
                print(f"twin {pid}: error {str(e)[:80]}", flush=True)


if __name__ == "__main__":
    main()

"""Fetch a twin's scan-spot panoramas so the game can 'walk' between them (display only; read-only Matterport query).

  uv run python scripts/fetch_hops.py 6375735 --spots 10

Writes fixtures/vision/feed_<pid>_hop<i>_f<k>.jpg (gitignored) and fixtures/vision/feed_<pid>_hops.json with each spot's
floor-plan position (metres, from the cached twin layout). Spots are spread out by farthest-point sampling.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")

import httpx  # noqa: E402

from app import costar, matterport, vision  # noqa: E402


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("pid")
    p.add_argument("--spots", type=int, default=10)
    p.add_argument("--neighbors", type=int, default=3, help="walk-graph links per spot (nearest scan spots)")
    p.add_argument("--model", help="a specific Matterport model (e.g. a suite's tour) instead of the building's twin")
    p.add_argument("--mesh", action="store_true", help="also cache the model's 50k interior mesh (untextured OBJ)")
    a = p.parse_args()
    model = a.model or (costar.get(a.pid).get("matterport_model_ids") or [None])[0]
    lp = ROOT / "fixtures" / "matterport" / f"{model}.json"
    if lp.exists():
        layout = json.loads(lp.read_text())
    else:  # not in the cached layouts: one read-only query for the scan spots
        layout = matterport._post('{ model(id: "%s") { locations { id position { x y z } } } }' % model)["model"]
    pos = {l["id"]: l["position"] for l in layout.get("locations") or [] if l.get("position")}
    q = '{ model(id: "%s") { panoLocations { id skybox(resolution: "2k") { status children } } } }' % model
    panos = {x["id"]: (x.get("skybox") or {}).get("children") or [] for x in matterport._post(q)["model"]["panoLocations"]}
    ids = [i for i in pos if i in panos and len(panos[i]) >= 6]
    print(f"model {model}: {len(pos)} scan spots, {len(panos)} panoramas, {len(ids)} matched by id")
    if not ids:
        sys.exit("no scan spot ids match panorama ids")
    chosen = [ids[0]]
    while len(chosen) < min(a.spots, len(ids)):  # farthest-point sampling: spread the hops across the floor
        far = max((i for i in ids if i not in chosen),
                  key=lambda i: min(math.dist((pos[i]["x"], pos[i]["y"]), (pos[c]["x"], pos[c]["y"])) for c in chosen))
        chosen.append(far)
    if a.spots >= len(ids):  # every spot: keep the scan's own order (spatially coherent), not sampling order
        chosen = ids
    old = {h["id"]: h for h in json.loads((vision.CACHE / f"feed_{a.pid}_hops.json").read_text())} \
        if (vision.CACHE / f"feed_{a.pid}_hops.json").exists() else {}
    hops = []
    for n, i in enumerate(chosen):
        faces = []
        for k, url in enumerate(panos[i][:6]):
            name = f"feed_{a.pid}_hop{n}_f{k}.jpg"
            prev = next((f["name"] for f in (old.get(i) or {}).get("faces", []) if f["face"] == f"f{k}"), None)
            if prev and (vision.CACHE / prev).exists():  # already fetched under another index: reuse, don't re-download
                if prev != name:
                    (vision.CACHE / name).write_bytes((vision.CACHE / prev).read_bytes())
                faces.append({"face": f"f{k}", "name": name})
                continue
            r = httpx.get(url, timeout=60)
            if r.status_code == 200 and r.headers.get("content-type", "").startswith("image"):
                (vision.CACHE / name).write_bytes(r.content)
                faces.append({"face": f"f{k}", "name": name})
        hops.append({"id": i, "x": round(pos[i]["x"], 2), "y": round(pos[i]["y"], 2), "faces": faces})
        print(f"hop {n}: ({pos[i]['x']:.1f}, {pos[i]['y']:.1f}) {len(faces)} faces")
    for h in hops:
        h["model"] = model
    if a.mesh:
        mesh = matterport._post('{ model(id: "%s") { assets { meshes { resolution url } } } }' % model)["model"]["assets"]["meshes"]
        m50 = next((m for m in mesh if m["resolution"] == "50k"), None)
        if m50:
            r = httpx.get(m50["url"], timeout=120)
            (ROOT / "fixtures" / "matterport" / "mesh").mkdir(parents=True, exist_ok=True)
            (ROOT / "fixtures" / "matterport" / "mesh" / f"{model}_50k.obj").write_bytes(r.content)
            print(f"mesh {model}: {len(r.content)} bytes")
    for h in hops:  # walk graph: each spot links to its nearest spots (real scans are 3-5 m apart, not a 2 m chain)
        near = sorted((math.dist((h["x"], h["y"]), (o["x"], o["y"])), o["id"]) for o in hops if o is not h)
        h["neighbors"] = [{"id": j, "m": round(d, 1)} for d, j in near[: a.neighbors]]
    (vision.CACHE / f"feed_{a.pid}_hops.json").write_text(json.dumps(hops))


if __name__ == "__main__":
    main()

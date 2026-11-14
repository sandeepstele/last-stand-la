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
    a = p.parse_args()
    model = (costar.get(a.pid).get("matterport_model_ids") or [None])[0]
    layout = json.loads((ROOT / "fixtures" / "matterport" / f"{model}.json").read_text())
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
    hops = []
    for n, i in enumerate(chosen):
        faces = []
        for k, url in enumerate(panos[i][:6]):
            r = httpx.get(url, timeout=60)
            if r.status_code == 200 and r.headers.get("content-type", "").startswith("image"):
                name = f"feed_{a.pid}_hop{n}_f{k}.jpg"
                (vision.CACHE / name).write_bytes(r.content)
                faces.append({"face": f"f{k}", "name": name})
        hops.append({"id": i, "x": round(pos[i]["x"], 2), "y": round(pos[i]["y"], 2), "faces": faces})
        print(f"hop {n}: ({pos[i]['x']:.1f}, {pos[i]['y']:.1f}) {len(faces)} faces")
    (vision.CACHE / f"feed_{a.pid}_hops.json").write_text(json.dumps(hops))


if __name__ == "__main__":
    main()

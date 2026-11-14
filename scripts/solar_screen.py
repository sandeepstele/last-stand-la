"""Screen CoStar's non-residential buildings for rooftop solar and rank them (the worker's overnight job).

  python scripts/solar_screen.py --limit 40            # largest floor plates first
  python scripts/solar_screen.py --ids 235279,362982   # specific CoStar property ids
  python scripts/solar_screen.py --refresh-yield       # re-fetch PVWatts yields (set NLR_API_KEY)

Reads the CoStar kit from COSTAR_KIT_DIR (outside the repo), fetches Vexcel roof data at each
building's CoStar coordinates (cached in fixtures/vexcel/<id>.json, gitignored), and writes the
ranking to fixtures/solar/ranking.json (gitignored: it contains licensed data).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

from app import costar, solar, vexcel  # noqa: E402

CACHE = ROOT / "fixtures" / "vexcel"
OUT = ROOT / "fixtures" / "solar"


def aerial_for(rec: dict, refetch: bool = False) -> dict | None:
    path = CACHE / f"{rec['property_id']}.json"
    if path.exists() and not refetch:
        return json.loads(path.read_text())
    try:
        raw = vexcel.property_extract(rec["latitude"], rec["longitude"])
        data = vexcel.normalize(raw, rec["property_id"], rec["latitude"], rec["longitude"])
    except vexcel.VexcelError as e:
        print(f"  {rec['property_id']}: Vexcel {e}")
        return None
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))
    return data


def refresh_yield() -> None:
    import httpx

    key = os.environ.get("NLR_API_KEY", "DEMO_KEY")
    path = ROOT / "app" / "data" / "solar_resource.json"
    data = json.loads(path.read_text())
    for city in ("houston", "los_angeles"):
        for tilt in (10, 20):
            p = {"api_key": key, "lat": data[city]["lat"], "lon": data[city]["lon"], "system_capacity": 1, "azimuth": 180,
                 "tilt": tilt, "array_type": 1, "module_type": 0, "losses": 14}
            r = httpx.get("https://developer.nlr.gov/api/pvwatts/v8.json", params=p, timeout=60)
            if r.status_code == 200:
                data[city][str(tilt)] = round(r.json()["outputs"]["ac_annual"], 1)
                print(f"{city} tilt {tilt}: {data[city][str(tilt)]} kWh/kW")
            else:
                print(f"{city} tilt {tilt}: HTTP {r.status_code} (keeping the old value)")
    path.write_text(json.dumps(data, indent=2) + "\n")


def main() -> None:
    load_dotenv(ROOT / ".env")
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=25)
    p.add_argument("--ids", default="")
    p.add_argument("--refetch", action="store_true")
    p.add_argument("--refresh-yield", action="store_true")
    a = p.parse_args()
    if a.refresh_yield:
        refresh_yield()
        return

    if a.ids:
        recs = [costar.get(x.strip()) for x in a.ids.split(",") if x.strip()]
    else:
        recs = sorted(costar.candidates(), key=lambda r: -(r["gba_sqft"] / (r["stories"] or 1)))[: a.limit]
    results = []
    for i, rec in enumerate(recs, 1):
        aerial = aerial_for(rec, a.refetch)
        lease = costar.lease_profile(rec["property_id"])
        s = solar.screen(rec, aerial, lease)
        results.append({"costar": {k: rec[k] for k in ("property_id", "property_type", "city", "gba_sqft", "stories", "year_built")},
                        "screen": s.to_dict()})
        print(f"[{i}/{len(recs)}] {rec['property_id']:>9} {rec['property_type']:<13} {s.status:<11} {s.headline[:110]}")
        time.sleep(0.2)  # be gentle with the Vexcel rate limit
    ranked = sorted(results, key=lambda r: -r["screen"]["priority"])
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "ranking.json").write_text(json.dumps(ranked, indent=1))
    print("\nTOP ROOFTOPS")
    for r in ranked[:10]:
        s, c = r["screen"], r["costar"]
        if s["status"] != "screened":
            continue
        print(f"  {c['property_id']:>9} {c['property_type']:<13} {c['city']:<12} {s['system_kw']:>7,.0f} kW "
              f"{s['annual_kwh'] / 1000:>7,.0f} MWh/yr {s['co2_t_per_year']:>6,.0f} t CO2  readiness={s['readiness']:<12} deal={s['deal_fit']}")
    skipped = [r for r in ranked if r["screen"]["status"] != "screened"]
    print(f"\n{len(skipped)} not sized (link check or no roof data); ranking saved to fixtures/solar/ranking.json (gitignored)")


if __name__ == "__main__":
    main()

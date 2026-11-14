"""Fetch one building from Vexcel and cache it for the agent (Gate #1 tool for C).

  python scripts/vexcel_probe.py --property-id HOU-0001 --lat 29.750043 --lon -95.406594
  python scripts/vexcel_probe.py --property-id HOU-0001 --lat ... --lon ... --detect

Writes (both gitignored: Vexcel data is licensed for the event):
  fixtures/vexcel/<id>.raw.json   the full property/extract response, to inspect every key
  fixtures/vexcel/<id>.json       the normalized record the verifier reads
Roof height comes with every call (include=precomputed,roof-height). --detect measures rooftop equipment
with elements/detect so usable roof area is real, not a count.
Needs VEXCEL_API_KEY in .env. Remember: latitude and longitude are separate flags; the API
itself wants POINT(lon lat), which this script builds for you.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

from app import vexcel  # noqa: E402
from app.layers import FIXTURES, check_property_id  # noqa: E402

ROOFTOP_LABELS = ["HVAC unit", "rooftop equipment", "skylight", "solar panel"]


def main() -> None:
    load_dotenv(ROOT / ".env")
    p = argparse.ArgumentParser()
    p.add_argument("--property-id", required=True)
    p.add_argument("--lat", type=float, required=True)
    p.add_argument("--lon", type=float, required=True)
    p.add_argument("--detect", action="store_true", help="measure rooftop equipment with elements/detect")
    p.add_argument("--buffer-m", type=float, default=None, help="use when the point misses the parcel (e.g. 30)")
    a = p.parse_args()

    pid = check_property_id(a.property_id)
    if not (-90 <= a.lat <= 90 and -180 <= a.lon <= 180):
        sys.exit("lat must be within ±90 and lon within ±180 (did you swap them?)")
    raw = vexcel.property_extract(a.lat, a.lon, buffer_m=a.buffer_m)
    out_dir = FIXTURES / "vexcel"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{pid}.raw.json").write_text(json.dumps(raw, indent=1))
    rec = vexcel.normalize(raw, pid, a.lat, a.lon)

    if a.detect:
        parcel_geometry = raw["features"][0].get("geometry")
        ring = vexcel.ring_lonlat(parcel_geometry)
        wkt = "POLYGON((" + ", ".join(f"{x} {y}" for x, y in ring) + "))"
        area, counts = vexcel.rooftop_area_sqft(vexcel.detect(wkt, ROOFTOP_LABELS))
        rec["roof_object_area_sqft"] = area
        rec["roof_objects_detected"] = counts
        rec["warnings"].append("rooftop equipment area = sum of detection boxes (an upper bound)")

    (out_dir / f"{pid}.json").write_text(json.dumps(rec, indent=1))
    shown = {k: rec[k] for k in ("source", "footprint_sqft", "height_m", "roof_condition_score", "roof_material",
                                 "roof_objects", "roof_object_area_sqft", "structure_count", "building_type", "inside_parcel")}
    print(json.dumps(shown, indent=1))
    for w in rec["warnings"]:
        print("warning:", w)
    print(f"saved fixtures/vexcel/{pid}.json (+ .raw.json); both are gitignored")


if __name__ == "__main__":
    main()

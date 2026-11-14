"""Run the verifier from the command line.

  # What does a twin say about its levels? (C runs this on CoStar's models in S2)
  python scripts/investigate.py --model Phin78u7wQN

  # Full investigation with record + aerial numbers (illustrative unless they come from CoStar/Vexcel)
  python scripts/investigate.py --model Phin78u7wQN --rba 38000 --stories 2 --footprint 13700 --city houston
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv  # noqa: E402

from app import interior, matterport  # noqa: E402
from app.verify import Aerial, Records, investigate, retrofit_math  # noqa: E402


def main() -> None:
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    p = argparse.ArgumentParser()
    p.add_argument("--model", help="Matterport model id")
    p.add_argument("--rba", type=float, help="listed rentable building area, sq ft")
    p.add_argument("--stories", type=int)
    p.add_argument("--footprint", type=float, help="Vexcel footprint, sq ft")
    p.add_argument("--height", type=float, help="Vexcel roof minus ground elevation, m")
    p.add_argument("--type", default="office")
    p.add_argument("--roof", default=None, help="roof condition, e.g. good/fair/poor")
    p.add_argument("--city", default="houston", choices=["houston", "los_angeles"])
    p.add_argument("--json", action="store_true")
    a = p.parse_args()

    prof = interior.profile(matterport.fetch_layout(a.model)) if a.model else None
    if prof and not a.rba:
        print(json.dumps(asdict(prof), indent=1) if a.json else _describe(prof))
        return

    rec = Records(rba_sqft=a.rba, stories=a.stories, building_type=a.type)
    aer = Aerial(footprint_sqft=a.footprint, height_m=a.height, roof_condition=a.roof)
    inv = investigate(rec, aer, prof)
    trusted = inv.final.gross_sqft * sum(inv.assumptions["efficiency_band"]) / 2
    fix = retrofit_math(rec, aer, trusted_area_sqft=max(a.rba, trusted), city=a.city)
    if a.json:
        print(json.dumps({"investigation": inv.to_dict(), "retrofit": asdict(fix)}, indent=1, default=str))
        return
    print(f"VERDICT  {inv.verdict}  (confidence {inv.confidence})\n{inv.headline}\n")
    print("before:", inv.initial.formula)
    print("after: ", inv.final.formula, "\n")
    for h in inv.hypotheses:
        print(f"  [{h.status:9}] {h.title:48} {h.evidence}")
    print(f"\nRETROFIT  {fix.panels} panels / {fix.system_kw} kW on {fix.usable_roof_sqft:,} sq ft usable roof")
    print(f"          {fix.annual_kwh:,} kWh/yr = {fix.load_offset_pct}% of load, {fix.co2_t_per_year} t CO2/yr. {fix.sequence}")
    print("          (PLACEHOLDER constants in app/verify.py ASSUMPTIONS; replace before the demo)")


def _describe(prof: interior.InteriorProfile) -> str:
    lines = [f"model {prof.model_id}: {prof.scanned_levels} scanned levels, {prof.unplaced_scans} unplaced scans"]
    for lv in prof.levels:
        tag = " <- entrance (first scan)" if lv.floor_id == prof.entrance_floor_id else ""
        z = f"{lv.median_z_m:+.2f} m" if lv.median_z_m is not None else "no scans"
        lines.append(f"  seq {lv.sequence}  {lv.label:12} {lv.n_scans:4} scans  median z {z}{tag}")
    lines.append(f"floor-to-floor: {prof.floor_to_floor_m} m (typical {prof.typical_floor_to_floor_m})")
    lines.append(f"levels below entrance: {[lv.label for lv in prof.levels_below_entrance]}")
    lines.append(f"mezzanine levels: {prof.mezzanine_levels}; entrance ambiguous: {prof.entrance_ambiguous}")
    lines += [f"note: {n}" for n in prof.notes]
    return "\n".join(lines)


if __name__ == "__main__":
    main()

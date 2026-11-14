"""Run the labelled case set through the deterministic evidence engine, offline."""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(__file__).with_name("cases.jsonl")
sys.path.insert(0, str(ROOT))


def read_cases(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def _offline_vision() -> None:
    """Make missing caches a no-evidence result, never a live request."""
    from app import vision

    def cached_ortho(pid, aer, collection=None):
        tag = collection or "latest"
        path = vision.CACHE / f"{pid}_ortho_{tag}.jpg"
        if not path.is_file():
            raise vision.VisionUnavailable("not cached")
        return path

    def cached_oblique(pid, aer):
        hits = sorted(vision.CACHE.glob(f"{pid}_oblique_*.jpg"))
        return hits[0] if hits else None

    def cached_panos(pid, suite, model_id, panos=2):
        hits = sorted(vision.CACHE.glob(f"{pid}_s{suite}_p*_f*.jpg"))
        if not hits:
            raise vision.VisionUnavailable("not cached")
        return hits

    def cached_cars(pid, aer):
        path = vision.CACHE / f"{pid}_cars.json"
        if not path.is_file():
            raise vision.VisionUnavailable("not cached")
        return json.loads(path.read_text())

    vision.ortho = cached_ortho
    vision.oblique = cached_oblique
    vision.suite_panos = cached_panos
    vision.car_counts = cached_cars


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", type=Path, default=DATA)
    args = parser.parse_args()
    load_dotenv(ROOT / ".env", override=True)
    os.environ["RADAR_LAYER_VEXCEL"] = "cached"
    os.environ["RADAR_MATTERPORT"] = "cached"
    os.environ["RADAR_REPLAY_STRICT"] = "1"
    _offline_vision()

    from app import evidence

    rows = read_cases(args.cases)
    labelled = [r for r in rows if r.get("truth") in evidence.CASES.get(r.get("case"), {}).get("hypotheses", {})]
    if not labelled:
        print(f"No labelled cases: {len(rows)} candidates loaded. Fill truth and evidence fields first.")
        return

    results = []
    for row in labelled:
        spec = evidence.CASES[row["case"]]
        checks = row.get("checks") or spec["checks"]
        out = evidence.weigh_case(row["property_id"], row["case"], checks, row.get("suite"))
        lead = out["verdict"]["hypothesis"]
        results.append({"truth": row["truth"], "lead": lead, "label": out["verdict"]["label"],
                        "confidence": out["verdict"]["confidence"], "checks": len(out["checks_used"])})

    total_correct = sum(r["truth"] == r["lead"] for r in results)
    print(f"Labelled cases: {len(results)} / {len(rows)}")
    print(f"Hypothesis accuracy: {total_correct / len(results):.1%} ({total_correct}/{len(results)})")
    print(f"Average checks used: {sum(r['checks'] for r in results) / len(results):.2f}")
    by_label: dict[str, list[dict]] = defaultdict(list)
    for r in results:
        by_label[r["label"]].append(r)
    print("Accuracy by verdict label:")
    for label in ("likely", "leaning", "unresolved"):
        group = by_label[label]
        correct = sum(r["truth"] == r["lead"] for r in group)
        print(f"  {label}: {correct}/{len(group)}" if group else f"  {label}: no cases")

    bins = ((0.0, 0.5), (0.5, 0.6), (0.6, 0.8), (0.8, 1.01))
    print("Confidence calibration (leader confidence vs whether leader matched truth):")
    for lo, hi in bins:
        group = [r for r in results if lo <= r["confidence"] < hi]
        if group:
            observed = sum(r["truth"] == r["lead"] for r in group) / len(group)
            mean = sum(r["confidence"] for r in group) / len(group)
            print(f"  {lo:.0%}-{min(hi, 1):.0%}: n={len(group)}, mean={mean:.1%}, observed={observed:.1%}")
        else:
            print(f"  {lo:.0%}-{min(hi, 1):.0%}: n=0")


if __name__ == "__main__":
    main()

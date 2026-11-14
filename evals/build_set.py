"""Create a private, locally labelled evaluation sample from the licensed event kit.

The output contains CoStar property IDs and is ignored by Git. It intentionally leaves
truth blank: a person must inspect independent evidence and label each case before eval.
"""

from __future__ import annotations

import json
import random
import sys
from datetime import date
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(__file__).with_name("cases.jsonl")
SEED = 20261114
sys.path.insert(0, str(ROOT))


def main() -> None:
    load_dotenv(ROOT / ".env", override=True)
    from app import retrofit_lists, tenants

    rng = random.Random(SEED)
    portfolio = retrofit_lists.portfolio()
    selected: list[dict] = []

    for case, limit in (("material_conflict", 15), ("stale_entry", 8)):
        candidates = [
            r for r in portfolio
            if case in {h["key"] for h in r["hypotheses"]}
        ]
        candidates.sort(key=lambda r: r["property_id"])
        if case == "material_conflict":
            from app import evidence

            strong = [r for r in candidates
                      if any(e["delta"] >= 0.25 for e in evidence.compliance_filings(r["property_id"], case)["effects"])
                      or any(e["delta"] >= 0.2 for e in evidence.permit_text(r["property_id"], case)["effects"])]
        else:
            from app import evidence

            strong = [r for r in candidates
                      if any(e["hypothesis"] == "replaced" and e["delta"] > 0
                             for e in evidence.replacement_permits(r["property_id"], case)["effects"])]
        strong_ids = {r["property_id"] for r in strong}
        remaining = [r for r in candidates if r["property_id"] not in strong_ids]
        chosen = strong[:limit] + rng.sample(remaining, max(0, min(limit - len(strong[:limit]), len(remaining))))
        selected.extend({"case": case, "property_id": r["property_id"]} for r in chosen)

    ghosts = tenants.queue_rows()
    # Enrich for labelable date-order evidence, then sample the remainder. This is an
    # evaluation sample, not a prevalence estimate; Matterport tour access can vary.
    today = date.today().isoformat()
    gaps: dict[tuple[str, str], int] = {}
    for r in ghosts:
        f = tenants.suite_facts(r["property_id"], r["suite"])
        starts = [t.get("tenant_since") for t in f["tenants"]]
        if (starts and f["listed_since"] and all(s and f["listed_since"] < s <= today for s in starts)):
            gaps[(r["property_id"], r["suite"])] = min(
                (date.fromisoformat(s) - date.fromisoformat(f["listed_since"])).days for s in starts)
    ranked = [r for r in ghosts if (r["property_id"], r["suite"]) in gaps]
    ranked.sort(key=lambda r: (-gaps[(r["property_id"], r["suite"])], r["property_id"], r["suite"]))
    labelable = []
    used_properties = set()
    for r in ranked:
        if r["property_id"] not in used_properties:
            labelable.append(r)
            used_properties.add(r["property_id"])
    others = [r for r in ghosts if r not in labelable]
    chosen_ghosts = labelable[:3] + rng.sample(others, min(4, len(others)))
    selected.extend({"case": "ghost_tenant", "property_id": r["property_id"], "suite": r["suite"]}
                    for r in chosen_ghosts)

    with OUT.open("w") as f:
        for row in selected:
            row.update({"truth": None, "confidence_of_label": None, "source_of_truth": None,
                        "checks": None})
            f.write(json.dumps(row, separators=(",", ":")) + "\n")
    print(f"Wrote {len(selected)} private candidates to {OUT} (15 material, 8 stale, 7 tenant when available).")
    print("Sample is enriched for directly labelable signals; do not treat it as a prevalence estimate.")
    print("Review each case, fill truth/confidence/source_of_truth, and set checks to the checks being evaluated.")


if __name__ == "__main__":
    main()

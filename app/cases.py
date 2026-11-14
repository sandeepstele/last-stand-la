"""The overnight case queue: every place a CoStar record disagrees with another source, ranked.

Shared by GET /cases/queue (the UI) and the worker's case_queue tool (the overnight sweep).
Stakes stay pure; cases whose imagery was already gathered sort first as a separate, labelled key.
"""

from __future__ import annotations

_QUEUE: dict = {"at": 0.0, "value": None}
QUEUE_TTL_S = 60.0


def queue() -> dict:
    import time

    if _QUEUE["value"] is None or time.monotonic() - _QUEUE["at"] > QUEUE_TTL_S:
        _QUEUE["value"], _QUEUE["at"] = build_queue(), time.monotonic()
    return _QUEUE["value"]


def build_queue() -> dict:
    from app import retrofit_lists

    rows = retrofit_lists.portfolio()
    cases: list[dict] = []
    for a in rows:
        keys = {h["key"] for h in a["hypotheses"]}
        past_due = any(h.get("past_due") for h in a["hypotheses"])
        for case in ("material_conflict", "stale_entry"):
            if case in keys:
                cases.append({"id": f"{case}:{a['property_id']}", "case": case, "property_id": a["property_id"], "address": a["address"],
                              "year_built": a["year_built"], "units": a["units"], "material": a["costar_material"],
                              "past_due": past_due, "stakes": (2 if past_due else 0) + (a["stories"] or 0) / 10 + (a["units"] or 0) / 100})
    try:
        from app import tenants

        cases += tenants.queue_rows()
    except Exception:  # ghost tenants not built or kit missing: the other cases still show
        pass
    from app import vision

    for c in cases:  # stakes stay pure; cases with their OWN imagery gathered sort first, as a separate key
        if c["case"] == "ghost_tenant":
            c["imagery"] = any(vision.CACHE.glob(f"{c['property_id']}_s{c['suite']}_*.jpg"))  # the suite's tour
        else:
            c["imagery"] = any(vision.CACHE.glob(f"{c['property_id']}_o*.jpg"))  # aerial: ortho / oblique
    cases.sort(key=lambda c: (not c["imagery"], -c["stakes"]))
    counts: dict[str, int] = {}
    for c in cases:
        counts[c["case"]] = counts.get(c["case"], 0) + 1
    return {"counts": counts, "total": len(cases), "top": cases[:25], "order": "cases with imagery gathered first, then by stakes",
            "source": "LA retrofit lists + CoStar kit, matched locally (fixtures/public)"}



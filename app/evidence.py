"""Cases and evidence: how the agent reasons about a contradiction instead of narrating a fixed answer.

A case opens when the records disagree (seismic findings from app/retrofit_lists.py):
  material_conflict  the city's concrete list vs CoStar's recorded material
  stale_entry        on a retrofit list, but CoStar says the building is newer than the ordinance

Each case has competing hypotheses with priors. Each check is a reusable unit: it reads one source and returns
what it found plus a signed confidence shift per hypothesis. The model decides which checks are worth running;
weigh_case() recomputes the named checks (numbers live here, never in the model) and returns the posterior,
a verdict, the next most useful check, and a DRAFT correction note that a person must approve.
Deltas are judgment calls, stated in each check's `why`, and kept small for weak evidence.
"""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any, Callable

from app import costar, retrofit_lists

CASES: dict[str, dict[str, Any]] = {
    "material_conflict": {
        "question": "The city lists this building as non-ductile concrete; CoStar records another material. Which is current?",
        "hypotheses": {
            "city_list_current": ("It is concrete: the city's list is right and CoStar's material is out of date", 0.45),
            "costar_current": ("It is the material CoStar records: the list entry is a screening false positive", 0.35),
            "different_structure": ("The two sources describe different structures at the same address", 0.20),
        },
        "checks": ["compliance_filings", "permit_text", "replacement_permits", "era_and_height", "site_structures"],
    },
    "stale_entry": {
        "question": "The building is on a retrofit list but CoStar says it was built after the ordinance's cutoff. Was it replaced?",
        "hypotheses": {
            "replaced": ("The listed building was demolished and replaced; the list entry is stale", 0.55),
            "year_is_renovation": ("Same building; CoStar's year built reflects a renovation, so the retrofit is still owed", 0.45),
        },
        "checks": ["replacement_permits", "compliance_filings", "era_and_height"],
    },
}

CHECK_WHAT = {
    "compliance_filings": "What the owner has filed with the city's retrofit program (checklist, plans, permit, completion)",
    "permit_text": "Work descriptions on retrofit permits at the address (materials named)",
    "replacement_permits": "Demolition or new-building permits at the address since 2020",
    "era_and_height": "Year built, stories and measured height per floor vs typical framing for each material",
    "site_structures": "How many structures Vexcel sees on the parcel",
}


def _effects(**d: float) -> list[dict[str, Any]]:
    return [{"hypothesis": k, "delta": round(v, 2)} for k, v in d.items() if v]


def _ctx(pid: str) -> tuple[dict[str, Any], dict[str, Any]]:
    rec = costar.get(pid)
    return rec, retrofit_lists.assess(rec)


# ------------------------------------------------------------------ checks


def compliance_filings(pid: str, case: str) -> dict[str, Any]:
    rec, a = _ctx(pid)
    e = next((x for x in a["lists"] if x["list"] == "non_ductile_concrete"), a["lists"][0] if a["lists"] else None)
    if not e:
        return {"finding": "not on a retrofit list", "effects": [], "why": "nothing filed to read"}
    done = {s["step"]: s["done"] for s in e["steps"]}
    filed = [f"{s['what']} ({s['done']})" for s in e["steps"] if s["done"]]
    finding = "filed: " + "; ".join(filed) if filed else "nothing filed with the program"
    if case == "material_conflict":
        if done.get("step_2"):
            return {"finding": finding, "effects": _effects(city_list_current=+0.35, costar_current=-0.25),
                    "why": "an engineer filed retrofit plans with the concrete program, which only applies to concrete buildings"}
        if done.get("step_1"):
            return {"finding": finding, "effects": _effects(city_list_current=+0.12, costar_current=-0.05),
                    "why": "the screening checklist was filed and the building stayed on the list (weak: the checklist is the owner's first look)"}
        return {"finding": finding, "effects": [], "why": "no filings, so the program has no engineer's view yet"}
    # stale_entry: filings dated after CoStar's year built mean the program still treats this building as in scope
    yb = rec.get("year_built")
    late = [d for d in done.values() if d and yb and int(d[:4]) >= yb]
    if late:
        return {"finding": finding, "effects": _effects(year_is_renovation=+0.25, replaced=-0.2),
                "why": f"filings dated {late[0]} are after CoStar's year built {yb}: the program is still working with this building"}
    return {"finding": finding, "effects": [], "why": "no filings after the year built, so no signal either way"}


def permit_text(pid: str, case: str) -> dict[str, Any]:
    _, a = _ctx(pid)
    words = " ".join(p["work"] for p in a["permits"]).upper()
    if not a["permits"]:
        return {"finding": "no retrofit permits on file since 2020", "effects": [], "why": "nothing to read"}
    if "CONCRETE" in words or "NON-DUCTILE" in words or "NONDUCTILE" in words:
        return {"finding": f"permit work mentions concrete: {a['permits'][0]['work'][:120]}",
                "effects": _effects(city_list_current=+0.25, costar_current=-0.15), "why": "the permitted work is a concrete retrofit"}
    if "STEEL" in words or "MOMENT FRAME" in words or "BRACED" in words:
        return {"finding": f"permit work mentions steel framing: {a['permits'][0]['work'][:120]}",
                "effects": _effects(costar_current=+0.2, different_structure=+0.05), "why": "steel framing named on a permit"}
    return {"finding": f"{len(a['permits'])} permit(s), no material named", "effects": [], "why": "no material named"}


@lru_cache(maxsize=1)
def _replacements() -> dict:
    return retrofit_lists._index(retrofit_lists._load("demo_new_permits"), "primary_address", "zip_code")


def replacement_permits(pid: str, case: str) -> dict[str, Any]:
    rec, _ = _ctx(pid)
    idx = _replacements()
    keys = {(retrofit_lists.key_addr(x), rec.get("zip") or "") for x in rec.get("street_addresses") or [] if retrofit_lists.key_addr(x)}
    hits = sorted(({"type": r.get("permit_type"), "issued": (r.get("issue_date") or "")[:10], "status": r.get("status_desc")}
                   for k in keys for r in idx.get(k, [])), key=lambda h: h["issued"])
    demo = [h for h in hits if h["type"] == "Bldg-Demolition"]
    new = [h for h in hits if h["type"] == "Bldg-New"]
    finding = (f"{len(demo)} demolition and {len(new)} new-building permit(s) since 2020"
               + (f", first {hits[0]['type']} {hits[0]['issued']}" if hits else "") + " (the city's permit data starts in 2020)")
    if case == "stale_entry":
        if demo or new:
            return {"finding": finding, "effects": _effects(replaced=+0.35, year_is_renovation=-0.3),
                    "why": "a demolition or new-building permit at this address fits a replaced building"}
        return {"finding": finding, "effects": _effects(replaced=-0.05),
                "why": "none since 2020; weak, because a replacement before 2020 would not show"}
    if demo or new:
        return {"finding": finding, "effects": _effects(different_structure=+0.2),
                "why": "construction on the site means the list and CoStar may describe different structures"}
    return {"finding": finding, "effects": [], "why": "no site change on record"}


def era_and_height(pid: str, case: str) -> dict[str, Any]:
    from app import layers

    rec, a = _ctx(pid)
    yb, st, mat = rec.get("year_built"), rec.get("stories"), rec.get("construction_material")
    per_floor = None
    try:
        h = layers.get_aerial(pid).get("height_m")
        per_floor = round(h / st, 2) if h and st else None
    except Exception:
        pass
    finding = f"built {yb}, {st} stories, CoStar {mat}" + (f", about {per_floor} m per floor from the aerial height" if per_floor else ", no aerial height")
    if case == "stale_entry":
        order = (a["lists"][0].get("order_date") or "")[:4] if a["lists"] else ""
        if yb and order and yb > int(order):
            return {"finding": finding + f"; ordered in {order}", "effects": _effects(replaced=+0.15),
                    "why": f"CoStar's year built {yb} is after the {order} retrofit order, which only targets older buildings"}
        return {"finding": finding, "effects": [], "why": "dates don't separate the hypotheses"}
    eff: dict[str, float] = {}
    why = []
    if per_floor is not None and not 2.4 <= per_floor <= 6.0:
        # Physically implausible: the aerial measured another structure, or the story count is off.
        return {"finding": finding, "effects": _effects(different_structure=+0.1),
                "why": f"{per_floor} m per floor is not a real floor height, so the aerial and the record don't describe the same structure"}
    if mat == "Masonry" and st and st >= 8:
        eff.update(costar_current=-0.15, city_list_current=+0.1)
        why.append("masonry bearing walls rarely reach 8+ stories")
    if mat == "Steel" and st and st >= 10 and yb and yb >= 1960:
        eff.update(costar_current=+0.05)
        why.append("steel framing is common for post-1960 towers")
    if per_floor and per_floor < 3.6:
        eff["city_list_current"] = eff.get("city_list_current", 0) + 0.05
        why.append("floors under 3.6 m fit concrete flat-slab framing better than steel")
    return {"finding": finding, "effects": _effects(**eff), "why": "; ".join(why) or "era and height fit either material (weak)"}


def site_structures(pid: str, case: str) -> dict[str, Any]:
    from app import layers

    try:
        v = layers.get_aerial(pid)
    except Exception as e:
        return {"finding": f"aerial unavailable ({type(e).__name__})", "effects": [], "why": "no data"}
    n = v.get("structure_count")
    if n is None:
        return {"finding": "structure count unavailable", "effects": [], "why": "no data"}
    if n > 1:
        return {"finding": f"Vexcel sees {n} structures on the parcel", "effects": _effects(different_structure=+0.15),
                "why": "several structures make it plausible the sources describe different ones"}
    return {"finding": "Vexcel sees one structure on the parcel", "effects": _effects(different_structure=-0.1),
            "why": "one structure leaves little room for a mix-up"}


CHECKS: dict[str, Callable[[str, str], dict[str, Any]]] = {
    "compliance_filings": compliance_filings,
    "permit_text": permit_text,
    "replacement_permits": replacement_permits,
    "era_and_height": era_and_height,
    "site_structures": site_structures,
}


# ------------------------------------------------------------------ cases


def cases_for(pid: str) -> list[str]:
    _, a = _ctx(pid)
    keys = {h["key"] for h in a["hypotheses"]}
    return [c for c in CASES if c in keys]


def open_case(pid: str) -> dict[str, Any]:
    found = cases_for(pid)
    return {
        "property_id": pid,
        "cases": [{"case": c, "question": CASES[c]["question"],
                   "hypotheses": [{"key": k, "claim": v[0], "prior": v[1]} for k, v in CASES[c]["hypotheses"].items()],
                   "checks": [{"check": k, "looks_at": CHECK_WHAT[k]} for k in CASES[c]["checks"]]} for c in found],
        "note": "No contradiction to investigate." if not found else "Pick the checks most likely to separate the hypotheses.",
    }


def run_check(pid: str, check: str, case: str) -> dict[str, Any]:
    if case not in CASES:
        return {"status": "bad_case", "allowed": list(CASES)}
    if check not in CASES[case]["checks"]:
        return {"status": "bad_check", "allowed": CASES[case]["checks"]}
    out = CHECKS[check](pid, case)
    return {"property_id": pid, "case": case, "check": check, "looks_at": CHECK_WHAT[check], **out}


def weigh_case(pid: str, case: str, checks: list[str]) -> dict[str, Any]:
    if case not in CASES:
        return {"status": "bad_case", "allowed": list(CASES)}
    spec = CASES[case]
    used = [c for c in dict.fromkeys(checks) if c in spec["checks"]]
    p = {k: v[1] for k, v in spec["hypotheses"].items()}
    trail = []
    for c in used:
        r = CHECKS[c](pid, case)
        for e in r["effects"]:
            p[e["hypothesis"]] = p.get(e["hypothesis"], 0) + e["delta"]
        trail.append({"check": c, "finding": r["finding"], "effects": r["effects"], "why": r["why"]})
    p = {k: max(v, 0.02) for k, v in p.items()}
    total = sum(p.values())
    post = {k: round(v / total, 2) for k, v in p.items()}
    lead, conf = max(post.items(), key=lambda kv: kv[1])
    label = "likely" if conf >= 0.6 else ("leaning" if conf >= 0.5 else "unresolved")
    remaining = [c for c in spec["checks"] if c not in used]
    rec, a = _ctx(pid)
    claim = spec["hypotheses"][lead][0]
    ticket = None
    if label in ("likely", "leaning") and case == "material_conflict" and lead == "city_list_current":
        ticket = (f"DRAFT for a CoStar researcher: {rec.get('address')} is recorded as {rec.get('construction_material')}; "
                  f"LA's non-ductile concrete program lists it (program filings: {next((t['finding'] for t in trail if t['check'] == 'compliance_filings'), 'not checked')}). "
                  "Please review the construction type.")
    elif label in ("likely", "leaning") and case == "stale_entry" and lead == "replaced":
        ticket = (f"DRAFT for the city's retrofit program: {rec.get('address')} appears replaced "
                  f"(CoStar year built {rec.get('year_built')}); the list entry may be stale.")
    return {"property_id": pid, "case": case, "checks_used": used, "trail": trail,
            "priors": {k: v[1] for k, v in spec["hypotheses"].items()}, "posterior": post,
            "verdict": {"hypothesis": lead, "claim": claim, "confidence": conf, "label": label},
            "next_check": remaining[0] if remaining and label != "likely" else ("a researcher's look at the twin or drawings" if label != "likely" else None),
            "correction_draft": ticket, "draft_needs_approval": bool(ticket)}

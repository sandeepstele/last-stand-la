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
        "checks": ["compliance_filings", "permit_text", "replacement_permits", "era_and_height", "site_structures",
                   "look_from_above", "compare_captures"],
    },
    "ghost_tenant": {
        "question": "CoStar records a tenant in this suite, and the suite is listed for lease right now. Is the tenant still there?",
        "hypotheses": {
            "still_there": ("Still there: the suite is being marketed ahead of the lease ending", 0.30),
            "gone_dark": ("Gone: the tenant has left and CoStar's occupancy record is out of date", 0.25),
            "subleasing": ("Subleasing: the tenant is offering its own space", 0.10),
            "moved_within": ("Moved within the building to another suite", 0.10),
            "listing_stale": ("The listing is stale: the suite was leased and the listing never came down", 0.25),
        },
        "checks": ["listing_timeline", "lease_terms", "tenancy_trail", "lot_activity", "suite_tour"],
    },
    "stale_entry": {
        "question": "The building is on a retrofit list but CoStar says it was built after the ordinance's cutoff. Was it replaced?",
        "hypotheses": {
            "replaced": ("The listed building was demolished and replaced; the list entry is stale", 0.55),
            "year_is_renovation": ("Same building; CoStar's year built reflects a renovation, so the retrofit is still owed", 0.45),
        },
        "checks": ["replacement_permits", "compliance_filings", "era_and_height", "compare_captures"],
    },
}

CHECK_WHAT = {
    "compliance_filings": "What the owner has filed with the city's retrofit program (checklist, plans, permit, completion)",
    "permit_text": "Work descriptions on retrofit permits at the address (materials named)",
    "replacement_permits": "Demolition or new-building permits at the address since 2020",
    "era_and_height": "Year built, stories and measured height per floor vs typical framing for each material",
    "site_structures": "How many structures Vexcel sees on the parcel",
    "listing_timeline": "When the suite went on the market, what kind of listing it is, and when the tenant moved in",
    "lease_terms": "The tenant's lease expiration on record",
    "tenancy_trail": "Whether the same company has newer locations, in this building or elsewhere",
    "lot_activity": "Cars around the building in the oldest vs the latest aerial capture (building-level, weak)",
    "suite_tour": "A vision read of the suite's own Matterport leasing tour (empty vs in use), double-checked",
    "look_from_above": "A vision read of the Vexcel oblique (side) and top-down images, double-checked by a skeptical second pass",
    "compare_captures": "The oldest vs newest Vexcel capture of the site: same building, or replaced?",
}

VISION_CAP = 0.2  # vision is evidence, never a verdict on its own


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


def _vision_result(r: dict[str, Any], effects: list[dict[str, Any]], why: str, callout: str) -> dict[str, Any]:
    for e in effects:
        e["delta"] = max(-VISION_CAP, min(VISION_CAP, e["delta"]))
    if r["answer"] == "cant_tell":
        second = f" (second look: {r['second_look']})" if r.get("first_answer") != "cant_tell" else ""
        return {"finding": f"can't tell from the images{second}", "effects": [], "why": "an unconfirmed read is not evidence",
                "images": r["images"], "callout": "Can't tell from the images", "vision": r}
    return {"finding": f"{r['answer'].replace('_', ' ')}: {r['observed']}", "effects": effects, "why": why,
            "images": r["images"], "callout": callout, "vision": r}


def look_from_above(pid: str, case: str) -> dict[str, Any]:
    from app import layers, vision

    rec, _ = _ctx(pid)
    try:
        aer = layers.get_aerial(pid)
        imgs = [p for p in (vision.oblique(pid, aer), vision.ortho(pid, aer)) if p]
        mat = (rec.get("construction_material") or "unknown").lower()
        r = vision.ask(pid, "facade", imgs, (
            "These are aerial images (an oblique side view if present, and a top-down view) of the building at the center. "
            "From its facade, what is its structural system most likely? exposed_concrete_frame = a visible grid of concrete "
            "columns and spandrels or concrete fins; precast_panels = repeated concrete cladding panels; curtain_wall = a "
            "continuous glass and metal skin typical of steel frames; masonry = brick or stone bearing walls. Also judge whether "
            f"more than one distinct building sits inside the center. (Records disagree: the city says concrete, CoStar says {mat}.)"),
            ["exposed_concrete_frame", "precast_panels", "curtain_wall", "masonry"])
    except Exception as e:
        return {"finding": f"images unavailable ({type(e).__name__}: {str(e)[:120]})", "effects": [], "why": "no images"}
    a = r["answer"]
    if a == "exposed_concrete_frame":
        return _vision_result(r, _effects(city_list_current=+0.2, costar_current=-0.1), "a concrete frame visible on the facade supports the city's list", "Concrete frame visible")
    if a == "precast_panels":
        return _vision_result(r, _effects(city_list_current=+0.08), "precast concrete cladding hangs on either a concrete or a steel frame, so it is weak", "Concrete panels (weak)")
    if a == "curtain_wall":
        return _vision_result(r, _effects(costar_current=+0.15, city_list_current=-0.05), "a glass curtain wall is typical of a steel frame", "Glass curtain wall")
    if a == "masonry":
        eff = _effects(costar_current=+0.15) if mat == "masonry" else _effects(different_structure=+0.05)
        return _vision_result(r, eff, "brick or stone walls fit a masonry record", "Masonry walls")
    return _vision_result(r, [], "", "")


def compare_captures(pid: str, case: str) -> dict[str, Any]:
    from app import layers, vision

    try:
        aer = layers.get_aerial(pid)
        hist = sorted(aer.get("footprint_history") or [], key=lambda h: h.get("date") or "")
        if len(hist) < 2:
            return {"finding": "only one capture on record", "effects": [], "why": "nothing to compare"}
        old, new = hist[0], hist[-1]
        imgs = [vision.ortho(pid, aer, old["collection"]), vision.ortho(pid, aer, new["collection"])]
        r = vision.ask(pid, "captures", imgs, (
            f"Two top-down aerial images of the same site: the first from {old['date']}, the second from {new['date']}. "
            "Is the building at the center the same building in both, or was it demolished and replaced by a different one "
            "(different roof shape, size or footprint), or is the site under construction in the later image?"),
            ["same_building", "replaced", "under_construction"])
    except Exception as e:
        return {"finding": f"captures unavailable ({type(e).__name__}: {str(e)[:120]})", "effects": [], "why": "no images"}
    a = r["answer"]
    dates = f" ({old['date'][:4]} vs {new['date'][:4]})"
    if case == "stale_entry":
        if a in ("replaced", "under_construction"):
            return _vision_result(r, _effects(replaced=+0.2, year_is_renovation=-0.15), "the site's building changed between captures", "Replaced" + dates)
        if a == "same_building":
            return _vision_result(r, _effects(year_is_renovation=+0.15, replaced=-0.1), "the same building stands in both captures", "Same building" + dates)
    else:
        if a in ("replaced", "under_construction"):
            return _vision_result(r, _effects(different_structure=+0.15), "the building changed, so the sources may describe different ones", "Changed" + dates)
        if a == "same_building":
            return _vision_result(r, _effects(different_structure=-0.05), "the same building stands throughout", "Same building" + dates)
    return _vision_result(r, [], "", "")


def _months(a: str, b: str) -> int:
    return (int(b[:4]) - int(a[:4])) * 12 + int(b[5:7]) - int(a[5:7])


def _facts(pid: str, suite: str) -> dict[str, Any]:
    from app import tenants

    return tenants.suite_facts(pid, suite)


def listing_timeline(pid: str, case: str, suite: str) -> dict[str, Any]:
    from datetime import date

    f = _facts(pid, suite)
    if not f["listings"] or not f["tenants"]:
        return {"finding": "no live listing or no current tenant for this suite", "effects": [], "why": "nothing to compare"}
    t, on = f["tenants"][0], f["listed_since"]
    kinds = sorted({x["type"] for x in f["listings"]})
    today = date.today().isoformat()
    months = _months(on, today) if on else None
    finding = (f"listed since {on} ({months} months, {', '.join(kinds)} listing); CoStar records {t['tenant']} here since {t['tenant_since']}")
    if any(k in ("sublet", "assignment") for k in kinds):
        return {"finding": finding, "effects": _effects(subleasing=+0.4, gone_dark=-0.05), "why": "a sublet listing is the tenant offering its own space"}
    if t["tenant_since"] and on and t["tenant_since"] > on:
        return {"finding": finding, "effects": _effects(listing_stale=+0.4, gone_dark=-0.15),
                "why": "the tenant moved in after the listing went up, so the listing is the stale record"}
    if months is not None and months >= 6:
        return {"finding": finding, "effects": _effects(gone_dark=+0.2, still_there=-0.05),
                "why": "a direct listing on the market for 6+ months over a long-standing tenant is unusual for a pre-lease"}
    return {"finding": finding, "effects": _effects(still_there=+0.1), "why": "a recent direct listing often precedes a lease end"}


def lease_terms(pid: str, case: str, suite: str) -> dict[str, Any]:
    from datetime import date

    f = _facts(pid, suite)
    t = f["tenants"][0] if f["tenants"] else {}
    exp = t.get("lease_expires")
    if not exp:
        return {"finding": "no lease expiration on record", "effects": [], "why": "CoStar has no lease term for this tenancy"}
    today = date.today().isoformat()
    if exp < today:
        return {"finding": f"lease expired {exp}, tenancy still marked current", "effects": _effects(gone_dark=+0.2, still_there=-0.1),
                "why": "an expired lease with no renewal on record fits a tenant that left"}
    if _months(today, exp) <= 12:
        return {"finding": f"lease expires {exp}", "effects": _effects(still_there=+0.2), "why": "marketing a suite in the last year of its lease is normal"}
    return {"finding": f"lease runs to {exp}", "effects": _effects(subleasing=+0.1, still_there=+0.05),
            "why": "years left on the lease: an early listing usually means sublet or a negotiated exit"}


def tenancy_trail(pid: str, case: str, suite: str) -> dict[str, Any]:
    f = _facts(pid, suite)
    t = f["tenants"][0] if f["tenants"] else {}
    if t.get("business_status") in ("out of business", "moved or merged"):
        return {"finding": f"CoStar marks the company {t['business_status']}", "effects": _effects(gone_dark=+0.3, still_there=-0.15),
                "why": "the company record itself says it is no longer operating here"}
    if f["trail_same_building"]:
        x = f["trail_same_building"][0]
        return {"finding": f"the same company took suite {x['suite']} in this building on {x['since']}",
                "effects": _effects(moved_within=+0.45, gone_dark=-0.1), "why": "a newer suite in the same building fits a move within it"}
    if f["trail_elsewhere"]:
        x = sorted(f["trail_elsewhere"], key=lambda o: o["since"])[0]
        return {"finding": f"the same company has {len(f['trail_elsewhere'])} newer location(s) elsewhere, first in {x['city']} on {x['since']} (after this listing)",
                "effects": _effects(gone_dark=+0.3, still_there=-0.1), "why": "it opened elsewhere after this suite went on the market"}
    return {"finding": "no newer location for this company on record", "effects": [], "why": "no trail either way"}


def lot_activity(pid: str, case: str, suite: str) -> dict[str, Any]:
    from app import layers, vision

    try:
        c = vision.car_counts(pid, layers.get_aerial(pid))
    except Exception as e:
        return {"finding": f"car counts unavailable ({type(e).__name__})", "effects": [], "why": "no data"}
    a, b = c["oldest"]["cars"], c["latest"]["cars"]
    finding = f"{a} cars ({c['oldest']['date'][:4]}) vs {b} cars ({c['latest']['date'][:4]}) around the building"
    if max(a, b) < 15:
        return {"finding": finding, "effects": [], "why": "too few cars visible to say anything (garage parking or street lots)"}
    change = (b - a) / max(a, 1)
    if change <= -0.3:
        return {"finding": finding, "effects": _effects(gone_dark=+0.1), "why": "fewer cars, but the lot serves the whole building: weak"}
    return {"finding": finding, "effects": _effects(still_there=+0.05), "why": "parking held up; building-level only, so weak"}


def suite_tour(pid: str, case: str, suite: str) -> dict[str, Any]:
    from app import vision

    f = _facts(pid, suite)
    tour = f["tour"]
    if not tour:
        return {"finding": "no tour of this suite on record", "effects": [], "why": "nothing to look at"}
    try:
        imgs = vision.suite_panos(pid, f["suite"], tour["model"])
        r = vision.ask(pid, f"suite{f['suite']}", imgs, (
            "These are views from a Matterport tour of one office suite. Is the suite empty (no desks, chairs or personal "
            "items), furnished and in use (desks with monitors, papers, personal items), furnished but unoccupied (furniture "
            "only, nothing personal), or under construction?"),
            ["empty", "furnished_in_use", "furnished_unoccupied", "under_construction"])
    except Exception as e:
        return {"finding": f"tour unavailable ({type(e).__name__}: {str(e)[:100]})", "effects": [], "why": "no images"}
    after = bool(f["listed_since"] and tour["date"] >= f["listed_since"])
    when = f"tour {tour['date']}, {'after' if after else 'before'} the listing went up"
    a = r["answer"]
    if a == "empty":
        eff = _effects(gone_dark=+0.2, still_there=-0.15) if after else _effects(gone_dark=+0.05)
        return _vision_result(r, eff, f"an empty suite in a {when}" + ("" if after else " (old tour, weak)"), f"Empty suite ({tour['date'][:7]})")
    if a == "furnished_in_use":
        eff = _effects(still_there=+0.2, subleasing=+0.05) if after else _effects(still_there=+0.05)
        return _vision_result(r, eff, f"desks in use in a {when}", f"In use ({tour['date'][:7]})")
    if a == "furnished_unoccupied":
        return _vision_result(r, _effects(gone_dark=+0.1, subleasing=+0.05) if after else [], f"furniture left behind, nobody working ({when})", f"Furnished, unoccupied ({tour['date'][:7]})")
    if a == "under_construction":
        return _vision_result(r, _effects(listing_stale=+0.1, gone_dark=+0.05), f"being built out ({when})", f"Under construction ({tour['date'][:7]})")
    return _vision_result(r, [], "", "")


GHOST_CHECKS = {"listing_timeline", "lease_terms", "tenancy_trail", "lot_activity", "suite_tour"}

CHECKS: dict[str, Callable[..., dict[str, Any]]] = {
    "listing_timeline": listing_timeline,
    "lease_terms": lease_terms,
    "tenancy_trail": tenancy_trail,
    "lot_activity": lot_activity,
    "suite_tour": suite_tour,
    "look_from_above": look_from_above,
    "compare_captures": compare_captures,
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


def _spec(c: str) -> dict[str, Any]:
    return {"case": c, "question": CASES[c]["question"],
            "hypotheses": [{"key": k, "claim": v[0], "prior": v[1]} for k, v in CASES[c]["hypotheses"].items()],
            "checks": [{"check": k, "looks_at": CHECK_WHAT[k]} for k in CASES[c]["checks"]]}


def open_case(pid: str, suite: str | None = None) -> dict[str, Any]:
    if suite:
        f = _facts(pid, suite)
        if not (f["tenants"] and f["listings"]):
            return {"property_id": pid, "suite": f["suite"], "cases": [], "note": "This suite is not both occupied on record and listed."}
        return {"property_id": pid, "suite": f["suite"], "tenant": f["tenants"][0]["tenant"], "cases": [_spec("ghost_tenant")],
                "note": "Pick the checks most likely to separate the hypotheses."}
    found = [c for c in cases_for(pid) if c != "ghost_tenant"]
    try:
        from app import tenants

        ghosts = sorted({c["suite"] for c in tenants.candidates() if c["property_id"] == str(pid) and not c["sublet"]})
    except Exception:
        ghosts = []
    return {
        "property_id": pid,
        **({"ghost_suites": ghosts, "ghost_note": "These suites are occupied on record and listed: open_case with suite= to investigate one."} if ghosts else {}),
        "cases": [_spec(c) for c in found],
        "note": "No contradiction to investigate." if not found else "Pick the checks most likely to separate the hypotheses.",
    }


def _call(check: str, pid: str, case: str, suite: str | None) -> dict[str, Any]:
    if check in GHOST_CHECKS:
        if not suite:
            return {"finding": "this check needs the suite", "effects": [], "why": "pass suite="}
        return CHECKS[check](pid, case, suite)
    return CHECKS[check](pid, case)


def run_check(pid: str, check: str, case: str, suite: str | None = None) -> dict[str, Any]:
    if case not in CASES:
        return {"status": "bad_case", "allowed": list(CASES)}
    if check not in CASES[case]["checks"]:
        return {"status": "bad_check", "allowed": CASES[case]["checks"]}
    out = _call(check, pid, case, suite)
    return {"property_id": pid, **({"suite": suite} if suite else {}), "case": case, "check": check, "looks_at": CHECK_WHAT[check], **out}


def weigh_case(pid: str, case: str, checks: list[str], suite: str | None = None) -> dict[str, Any]:
    if case not in CASES:
        return {"status": "bad_case", "allowed": list(CASES)}
    spec = CASES[case]
    used = [c for c in dict.fromkeys(checks) if c in spec["checks"]]
    p = {k: v[1] for k, v in spec["hypotheses"].items()}
    trail = []
    for c in used:
        r = _call(c, pid, case, suite)
        for e in r["effects"]:
            p[e["hypothesis"]] = p.get(e["hypothesis"], 0) + e["delta"]
        trail.append({"check": c, "finding": r["finding"], "effects": r["effects"], "why": r["why"],
                      **({"images": r["images"], "callout": r.get("callout")} if r.get("images") else {})})
    p = {k: max(v, 0.02) for k, v in p.items()}
    total = sum(p.values())
    post = {k: round(v / total, 2) for k, v in p.items()}
    lead, conf = max(post.items(), key=lambda kv: kv[1])
    runner_up = sorted(post.values())[-2] if len(post) > 1 else 0.0
    margin = conf - runner_up
    # with five hypotheses the leader rarely passes 50%, so its lead over the runner-up counts too
    label = ("likely" if conf >= 0.6 or (conf >= 0.5 and margin >= 0.3)
             else "leaning" if conf >= 0.5 or (conf >= 0.4 and margin >= 0.2) else "unresolved")
    remaining = [c for c in spec["checks"] if c not in used]
    rec = costar.get(pid) if case == "ghost_tenant" else _ctx(pid)[0]
    claim = spec["hypotheses"][lead][0]
    ticket = None
    if case == "ghost_tenant":
        f = _facts(pid, suite or "")
        t = f["tenants"][0] if f["tenants"] else {}
        if label in ("likely", "leaning") and lead in ("gone_dark", "moved_within", "listing_stale"):
            fix = {"gone_dark": "re-verify occupancy; the tenant record may be out of date",
                   "moved_within": "check whether the tenant moved to another suite in the building",
                   "listing_stale": "the listing may have been leased; confirm and take it off market"}[lead]
            ticket = (f"DRAFT for a CoStar researcher: suite {f['suite']} at {rec.get('address')} is recorded as occupied by "
                      f"{t.get('tenant', 'a tenant')} since {t.get('tenant_since')}, and it has been listed for lease since {f['listed_since']}. "
                      f"Evidence: {'; '.join(x['finding'] for x in trail[:3])}. Please {fix}.")
    elif label in ("likely", "leaning") and case == "material_conflict" and lead == "city_list_current":
        ticket = (f"DRAFT for a CoStar researcher: {rec.get('address')} is recorded as {rec.get('construction_material')}; "
                  f"LA's non-ductile concrete program lists it (program filings: {next((t['finding'] for t in trail if t['check'] == 'compliance_filings'), 'not checked')}). "
                  "Please review the construction type.")
    elif label in ("likely", "leaning") and case == "stale_entry" and lead == "replaced":
        ticket = (f"DRAFT for the city's retrofit program: {rec.get('address')} appears replaced "
                  f"(CoStar year built {rec.get('year_built')}); the list entry may be stale.")
    return {"property_id": pid, **({"suite": suite} if suite else {}), "case": case, "checks_used": used, "trail": trail,
            "priors": {k: v[1] for k, v in spec["hypotheses"].items()}, "posterior": post,
            "verdict": {"hypothesis": lead, "claim": claim, "confidence": conf, "label": label},
            "next_check": remaining[0] if remaining and label != "likely" else ("a researcher's look at the twin or drawings" if label != "likely" else None),
            "correction_draft": ticket, "draft_needs_approval": bool(ticket)}

"""Bob's Desk: every number on Bob's desk, computed in code from the records (the model never sets one).

  card      one line per data source for a building (CoStar record, Vexcel aerial, Matterport scan, the city's
            retrofit list, the 1994 ShakeMap, open record cases), the fields where two sources disagree, the people
            inside by time of day, and the rapid screening score
  screen    a FEMA P-154-style rapid visual screening score for each material the evidence still allows, weighted by
            today's odds (app/evidence.weigh_case), the chance of serious damage in the dawn aftershock, the people who
            would be inside, and the tag the code suggests
  triage    the district ranked by expected people at risk (the map layer and the tagging order)
  tag       Bob's confirmed tag (the agent proposes; Bob approves or changes it through the interrupt)
  shift     the dawn aftershock: a seeded roll per tagged building, people kept safe, people displaced, records fixed

Sources for the published values (see the table comments): FEMA P-154 3rd ed. (2015) Level 1 basic scores and
modifiers for very high seismicity, its S = -log10(P[collapse | MCE ground motion]) definition, the 2.0 cut-off for a
detailed evaluation; IBC 2021 Table 1004.5 occupant load factors; HAZUS-MH time-of-day occupancy; the ATC-20 posting
rule (severe and overall = red, localized severe or overall moderate = yellow). Game parts are labelled as game parts.
Tags and the aftershock are game outcomes, not engineering assessments. Wording stays hedged: records "disagree".
"""

from __future__ import annotations

import math
import random
from functools import lru_cache
from typing import Any

from app import costar, fortress

LOG_SEED = """## Shift 2026-11-13
- 601 Broadway: agent_suggested=yellow; bob_tag=red; agreed=false; damage=extensive; right_tag=red; bob_right=true; agent_right=false; people_safe=135
- score: people_safe=135/135; records_fixed=1
Lesson: Bob overrode my yellow and was right; lean red sooner when the walls are uncertain.
"""

DISCLAIMER = fortress.DISCLAIMER

# ---------------------------------------------------------------- FEMA P-154 (2015), Level 1, Very High seismicity
# Verbatim from the P-154 3rd-edition data collection forms (Appendix B, p. B-2). LA is a Very High region. Only the
# modifiers our records can decide are applied (pre-code, post-benchmark); irregularities and soil are not in the data.
P154_BASIC = dict(W1=2.1, W2=1.8, S1=1.5, S5=1.2, C1=1.0, C2=1.2, C3=0.9, RM1=1.1, URM=0.9)
P154_PRECODE = dict(W1=-0.3, W2=-0.3, S1=-0.3, S5=-0.1, C1=-0.1, C2=-0.2, C3=0.0, RM1=-0.2, URM=0.0)
P154_POSTBENCH = dict(W1=1.9, W2=2.0, S1=1.0, S5=None, C1=1.4, C2=1.7, C3=None, RM1=1.6, URM=None)
P154_SMIN = dict(W1=0.7, W2=0.7, S1=0.5, S5=0.5, C1=0.3, C2=0.3, C3=0.3, RM1=0.3, URM=0.2)
# The jurisdiction sets these (P-154 leaves them to the supervising engineer): assumed, labelled on screen.
PRE_CODE_BEFORE = 1933  # LA: the 1933 Long Beach quake and the Riley Act
BENCHMARK = dict(W1=1976, W2=1976, S1=1994, C1=1976, C2=1994, RM1=1997)  # ASCE 41 benchmark years (assumed)
CUTOFF = 2.0  # P-154: below this, a detailed structural evaluation is recommended

# ---------------------------------------------------------------- HAZUS (damage at the building's 1994 shaking)
# Code era for UBC zone 4 (HAZUS Table 5.20 via USGS ShakeCast): post-1975 high, 1941-1975 moderate, pre-1941 pre-code.
# Equivalent-PGA fragility medians (g) for slight, moderate, extensive, complete (SimCenter's HAZUS 6.1 data).
FRAGILITY = {
    "C1L": {"high": (.21, .35, .70, 1.37), "moderate": (.16, .23, .41, .77), "pre": (.10, .12, .21, .36)},
    "C1M": {"high": (.15, .27, .73, 1.61), "moderate": (.13, .21, .49, .89), "pre": (.09, .13, .26, .43)},
    "C2M": {"high": (.17, .36, .87, 1.95), "moderate": (.15, .26, .55, 1.02), "pre": (.10, .15, .30, .50)},
    "URML": {"low": (.14, .20, .32, .46), "pre": (.13, .17, .26, .37)},
    "URMM": {"low": (.10, .16, .27, .46), "pre": (.09, .13, .21, .38)},
    "S1L": {"high": (.19, .31, .64, 1.49), "moderate": (.15, .22, .42, .80), "pre": (.09, .13, .22, .38)},
    "RM1L": {"high": (.30, .46, .93, 1.57), "moderate": (.22, .30, .50, .85), "pre": (.13, .16, .24, .43)},
    "W1": {"high": (.26, .55, 1.28, 2.01), "moderate": (.24, .43, .91, 1.34), "pre": (.18, .29, .51, .77)},
}
BETA = 0.64  # HAZUS manual dispersion for equivalent-PGA curves (SimCenter's file lists 0.4): labelled
# Indoor casualty rates, % of occupants [severity 1..4] per damage state; complete splits by P(collapse | complete).
INJURY = {
    "C": {"slight": (.05, 0, 0, 0), "moderate": (.25, .03, 0, 0), "extensive": (1, .1, .001, .001),
          "complete": (5, 1, .01, .01), "collapse": (40, 20, 5, 10)},
    "URM": {"slight": (.05, 0, 0, 0), "moderate": (.35, .4, .001, .001), "extensive": (2, .2, .002, .002),
            "complete": (10, 2, .02, .02), "collapse": (40, 20, 5, 10)},
    "W": {"slight": (.05, 0, 0, 0), "moderate": (.25, .03, 0, 0), "extensive": (1, .1, .001, .001),
          "complete": (5, 1, .01, .01), "collapse": (40, 20, 3, 5)},
}
P_COLLAPSE = {"C1L": .13, "C1M": .10, "C2M": .10, "URML": .15, "URMM": .15, "S1L": .08, "RM1L": .13, "W1": .03}
STATES = ("none", "slight", "moderate", "extensive", "complete")

# ---------------------------------------------------------------- people (IBC 2021 Table 1004.5; ACS; HAZUS 6.1)
LOAD_SQFT = {"office": 150, "retail": 60, "industrial": 100, "hospitality": 200}  # business 150 verified
TYPICAL_SHARE = 0.5  # people typically inside vs the code's design maximum (assumed, labelled; the last fallback)
HOUSEHOLD = 2.64     # people per household, City of LA (ACS 2019-2023)
# HAZUS 6.1 share of peak population present: night 0-5 h & 20-23 h, day 9-15 h, commute 6-8 h & 16-19 h (5 pm = commute)
TIME_OF_DAY = {"residential": {"night": 1.0, "day": 0.53, "commute": 0.35},
               "commercial": {"night": 0.01, "day": 1.0, "commute": 0.75}}

# ---------------------------------------------------------------- game parts (labelled as such)
RED_AT = 0.40           # game: chance of extensive-or-worse damage at or above this suggests red (ATC-20: severe, overall)
YELLOW_AT = RED_AT / 2  # ATC-138's rule: "inspection required" at half of each red-tag threshold
BORDER = 0.05     # within this of a threshold: borderline
SEED = 2026


def _phi(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def pga_g(mmi: float) -> float:
    """Worden et al. 2012 (California), MMI to PGA: PGA = 10^((MMI + 1.60) / 3.70) cm/s^2."""
    return 10 ** ((mmi + 1.60) / 3.70) / 980.665


def _kind(rec: dict[str, Any]) -> str:
    t = (rec.get("property_type") or "").lower()
    return next((k for k in LOAD_SQFT if k in t), "office")


def fema_type(material: str, year: int | None) -> str:
    y = year or 1950
    return {"concrete": "C1", "masonry": "URM" if y < 1934 else "RM1", "steel": "S1", "wood": "W1"}.get(material, "C1")


def _hazus_class(fema: str, stories: int | None, year: int | None) -> tuple[str, str]:
    n, y = stories or 3, year or 1950
    era = "high" if y > 1975 else "moderate" if y >= 1941 else "pre"
    cls = {"C1": "C1L" if n <= 3 else "C1M", "C2": "C2M", "C3": "C1L" if n <= 3 else "C1M", "URM": "URML" if n <= 2 else "URMM",
           "RM1": "RM1L", "S1": "S1L", "S5": "S1L", "W1": "W1", "W2": "W1"}[fema]
    if cls.startswith("URM") and era != "pre":
        era = "low"
    return cls, era


def p154(fema: str, year: int | None) -> dict[str, Any]:
    y = year or 1950
    mods = []
    if y < PRE_CODE_BEFORE and P154_PRECODE[fema]:
        mods.append({"why": f"pre-code (built before {PRE_CODE_BEFORE})", "value": P154_PRECODE[fema]})
    if P154_POSTBENCH.get(fema) and BENCHMARK.get(fema) and y >= BENCHMARK[fema]:
        mods.append({"why": f"post-benchmark (built {BENCHMARK[fema]} or later)", "value": P154_POSTBENCH[fema]})
    s = max(P154_SMIN[fema], round(P154_BASIC[fema] + sum(m["value"] for m in mods), 2))
    return {"fema_type": fema, "basic": P154_BASIC[fema], "modifiers": mods, "s_min": P154_SMIN[fema], "score": s,
            "detailed_evaluation": s < CUTOFF}


def damage(cls: str, era: str, pga: float) -> dict[str, float]:
    med = FRAGILITY[cls][era]
    ex = [_phi(math.log(pga / m) / BETA) for m in med]  # P(>= slight .. complete)
    probs = [1 - ex[0], ex[0] - ex[1], ex[1] - ex[2], ex[2] - ex[3], ex[3]]
    return {k: round(v, 3) for k, v in zip(STATES, probs)}


def injuries(cls: str, p_ds: dict[str, float], occupants: float) -> list[float]:
    rates = INJURY["URM" if cls.startswith("URM") else "W" if cls.startswith("W") else "C"]
    pc = P_COLLAPSE[cls]
    out = [0.0] * 4
    for ds in ("slight", "moderate", "extensive"):
        out = [o + p_ds[ds] * r / 100 for o, r in zip(out, rates[ds])]
    out = [o + p_ds["complete"] * ((1 - pc) * a + pc * b) / 100 for o, a, b in zip(out, rates["complete"], rates["collapse"])]
    return [round(occupants * o, 2) for o in out]


@lru_cache(maxsize=1)
def _occupied() -> dict[str, float]:
    """Square feet CoStar's current tenancies occupy in each building (location-occupancy spaces). Totals only."""
    import collections

    from app import tenants

    out: dict[str, float] = collections.defaultdict(float)
    try:
        for (pid, _suite), recs in tenants._index()["current"].items():
            out[str(pid)] += sum(r.get("sqft") or 0 for r in recs)
    except Exception:
        return {}
    return dict(out)


def people(pid: str) -> dict[str, Any]:
    rec = costar.get(pid)
    kind = _kind(rec)
    units = rec.get("units") or 0
    emp = fortress._employees().get(pid, 0)
    gba = rec.get("gba_sqft") or 0
    if units:
        base = units * HOUSEHOLD
        tod = TIME_OF_DAY["residential"]
        low, high = round(base * 0.6), round(base * 1.2)
        basis = f"{units} apartments on record x {HOUSEHOLD} people per LA household (ACS)"
    else:
        design = gba / LOAD_SQFT[kind]
        tod = TIME_OF_DAY["commercial"]
        if emp:
            base, low, high = emp, round(emp * 0.5), round(min(design, emp * 1.2) or emp * 1.2)
            basis = f"about {emp} employees on record (CoStar); up to {round(design):,} by the code's design load"
        elif _occupied().get(pid):
            occ = _occupied()[pid]
            base = occ / LOAD_SQFT[kind]
            low, high = round(base * 0.5), round(min(design, base * 1.2) or base * 1.2)
            basis = (f"about {round(occ, -2):,.0f} sq ft occupied (CoStar tenancies) / {LOAD_SQFT[kind]} sq ft per person "
                     f"(IBC design load)")
        else:
            base = design * TYPICAL_SHARE
            low, high = round(design * 0.3), round(design)
            basis = (f"about {round(gba, -3):,.0f} sq ft / {LOAD_SQFT[kind]} sq ft per person (IBC design load) "
                     f"x {TYPICAL_SHARE} typically there (assumed)")
    day, night, at_5pm = round(base * tod["day"]), round(base * tod["night"]), round(base * tod["commute"])
    basis += f"; HAZUS share present by day {tod['day']}, at 5 pm (commute) {tod['commute']}, at night {tod['night']}"
    # a tag protects whoever uses the building next: the larger of the day and night counts
    return {"day": day, "at_5pm": at_5pm, "night": night, "at_stake": max(day, night), "low": low, "high": max(high, low),
            "kind": "residential" if units else kind, "basis": basis}


def _material_odds(pid: str, checks: list[str], notes: list[dict]) -> list[tuple[str, float]]:
    """[(material, odds)]: CoStar's material, or the material_conflict posterior when the city's list disagrees."""
    rec = costar.get(pid)
    mat = fortress._material(rec)
    w = fortress.walls(pid, checks, notes)
    post = w.get("posterior")
    if not post:
        return [(mat, 1.0)]
    out: dict[str, float] = {}
    for h, p in post.items():
        m = fortress.HYPOTHESIS_MATERIAL.get(h, mat)
        m = mat if m == "unknown" else m
        out[m] = out.get(m, 0) + p
    return sorted(out.items(), key=lambda kv: -kv[1])


def screen(pid: str, checks: list[str] | tuple[str, ...] = (), notes: list[dict] | None = None) -> dict[str, Any]:
    pid = str(pid)
    rec = costar.get(pid)
    year, stories = rec.get("year_built"), rec.get("stories")
    city, mmi = fortress._city(rec), fortress._mmi(rec) or 7.0
    pga = pga_g(mmi)
    ppl = people(pid)
    rows = []
    for mat, odds in _material_odds(pid, list(checks), notes or []):
        f = fema_type(mat, year)
        cls, era = _hazus_class(f, stories, year)
        p_ds = damage(cls, era, pga)
        rows.append({"material": mat, "odds": round(odds, 2), **p154(f, year), "hazus_class": cls, "code_era": era,
                     "damage": p_ds, "p_extensive_plus": round(p_ds["extensive"] + p_ds["complete"], 3),
                     "p_moderate_plus": round(p_ds["moderate"] + p_ds["extensive"] + p_ds["complete"], 3),
                     "injuries_if_open": injuries(cls, p_ds, ppl["at_stake"])})
    mix = lambda k: round(sum(r["odds"] * r[k] for r in rows), 3)
    p_ext, p_mod = mix("p_extensive_plus"), mix("p_moderate_plus")
    s = round(sum(r["odds"] * r["score"] for r in rows), 2)
    hurt = [round(sum(r["odds"] * r["injuries_if_open"][k] for r in rows), 2) for k in range(4)]
    if p_ext >= RED_AT:
        suggest = "red"
        why = f"a {round(p_ext * 100)}% chance of extensive or worse damage at this site's 1994 shaking (red at {round(RED_AT * 100)}%)"
    elif p_ext >= YELLOW_AT or s < CUTOFF or city["unfinished"]:
        suggest = "yellow"
        bits = [f"a {round(p_ext * 100)}% chance of extensive or worse damage"]
        if s < CUTOFF:
            bits.append(f"screening score {s} is under the {CUTOFF} cut-off")
        if city["unfinished"]:
            bits.append("the city's retrofit order is not finished")
        why = "; ".join(bits) + ": restricted use until a detailed evaluation"
    else:
        suggest, why = "green", f"screening score {s} and a {round(p_mod * 100)}% chance of moderate or worse damage"
    borderline = abs(p_ext - RED_AT) <= BORDER or (suggest != "red" and abs(p_ext - YELLOW_AT) <= BORDER and s >= CUTOFF)
    if len(rows) > 1:
        why += f" (the walls are still in question: {', '.join(r['material'] + ' ' + str(round(r['odds'] * 100)) + '%' for r in rows)})"
    return {"pid": pid, "label": fortress._label(rec), "by_material": rows, "score": s, "mmi": mmi, "pga_g": round(pga, 3),
            "p_damage": p_ext, "p_extensive_plus": p_ext, "p_moderate_plus": p_mod, "people": ppl,
            "injuries_if_open": hurt, "expected_at_risk": round(p_ext * ppl["at_stake"]), "suggest": suggest,
            "borderline": borderline, "why": why,
            "rule": f"Screening: FEMA P-154 Level 1, Very High seismicity, basic score + year modifiers (pre-code before "
                    f"{PRE_CODE_BEFORE}, benchmark years assumed), {CUTOFF} cut-off. Damage: HAZUS fragility for the "
                    f"building class and code era at the 1994 Northridge shaking here (MMI {mmi} = {pga:.2f} g, Worden 2012), "
                    f"beta {BETA}. Each material weighted by today's odds. Tag: red if extensive-or-worse is "
                    f"{round(RED_AT * 100)}%+ (game threshold), yellow at half that ({round(YELLOW_AT * 100)}%+, ATC-138's "
                    f"inspection rule) or when the score is under the cut-off or a city order is open, else green. {DISCLAIMER}."}


def in_la(pid: str) -> bool:
    """Any LA building in the CoStar kit (all 1,581), not only the district."""
    try:
        rec = costar.get(str(pid))
    except Exception:
        return False
    return (rec.get("city") or "").strip().lower() == "los angeles" and bool(rec.get("latitude")) and not rec.get("synthetic")


def card(pid: str, checks: list[str] | tuple[str, ...] = (), notes: list[dict] | None = None, live: bool = False) -> dict[str, Any]:
    """Bob's building card: what each data source says, where they disagree, people, screening (code only). live=True
    pulls Vexcel from its API when this building has no cached aerial yet (HTTP only; agent tools stay cached)."""
    from app import cases, layers

    pid = str(pid)
    rec = costar.get(pid)
    aer, pulled = fortress._aerial(pid), False
    if aer is None and live:
        try:
            aer, pulled = layers.get_aerial(pid, rec), True
        except Exception:
            aer = None
    mat, city, mmi = fortress._material(rec), fortress._city(rec), fortress._mmi(rec)
    feeds = fortress._feeds(pid)
    sources, conflicts = [], []
    gba = rec.get("gba_sqft") or 0
    sources.append({"key": "costar", "source": "CoStar record", "status": "ok", "lines": [
        f"{rec.get('stories') or '?'} floors, built {rec.get('year_built') or 'year unknown'}, {mat} on record",
        f"about {round(gba, -3):,.0f} sq ft, {(rec.get('property_type') or 'building').lower()}"
        + (f", {rec['units']} apartments" if rec.get("units") else "")]})
    if aer:
        h, st = aer.get("height_m"), rec.get("stories")
        lines = [f"measured roof height {h:.0f} m" + (f" (about {h / st:.1f} m per floor)" if h and st else "") if h else "no measured height",
                 f"{aer.get('roof_shape') or 'unknown'} roof" + (f", Vexcel roof condition score {aer['roof_condition_score']:.1f} (1-5 scale)" if isinstance(aer.get("roof_condition_score"), (int, float)) else "")
                 + f"; captured {(aer.get('capture_date') or '')[:7]}"]
        status = "ok"
        if h and st and not 2.4 <= h / st <= 6.0:
            status = "conflict"
            conflicts.append({"field": "height", "a": {"source": "CoStar record", "value": f"{st} floors"},
                              "b": {"source": "Vexcel aerial", "value": f"{h:.0f} m tall"}})
        if pulled:
            lines.append("pulled live from Vexcel just now")
        sources.append({"key": "vexcel", "source": "Vexcel aerial", "status": status, "lines": lines})
    else:
        sources.append({"key": "vexcel", "source": "Vexcel aerial", "status": "missing", "lines": ["no aerial cached for this building"]})
    from app import county

    ca = county.assessor(pid)
    if ca:
        cy, gy = ca.get("year_built"), rec.get("year_built")
        lines = [f"built {cy or 'year not on the roll'}" + (f", effective year {ca['effective_year']}" if ca.get("effective_year") else "")
                 + (f", about {ca['sqft']:,} sq ft" if ca.get("sqft") else ""),
                 f"use on the roll: {(ca.get('use') or 'not given').lower()}"]
        status = "ok"
        if cy and gy and abs(int(cy) - int(gy)) > 5:
            status = "conflict"
            conflicts.append({"field": "year built", "a": {"source": "CoStar record", "value": str(gy)},
                              "b": {"source": "LA County Assessor", "value": str(cy)}})
        if ca.get("sqft") and gba and not 0.8 <= ca["sqft"] / gba <= 1.25:
            status = "conflict"
            conflicts.append({"field": "floor area", "a": {"source": "CoStar record", "value": f"{round(gba):,} sq ft"},
                              "b": {"source": "LA County Assessor", "value": f"{ca['sqft']:,} sq ft"}})
        sources.append({"key": "assessor", "source": "LA County Assessor", "status": status, "lines": lines})
    lr = county.lariac(pid)
    if lr and lr.get("height_m"):
        st = rec.get("stories")
        lines = [f"surveyed roof height {lr['height_m']:.0f} m ({lr['height_ft']:.0f} ft)"
                 + (f", about {lr['height_m'] / st:.1f} m per floor" if st else ""), "LA County survey, 2008 imagery"]
        status = "ok"
        if st and not 2.4 <= lr["height_m"] / st <= 6.0:
            status = "conflict"
            conflicts.append({"field": "height", "a": {"source": "CoStar record", "value": f"{st} floors"},
                              "b": {"source": "LA County survey", "value": f"{lr['height_m']:.0f} m tall"}})
        sources.append({"key": "lariac", "source": "LA County building survey", "status": status, "lines": lines})
    bz = county.businesses(pid)
    if bz is not None:
        on_record = fortress._employees().get(pid, 0)
        top = ", ".join(i["what"] for i in bz["industries"][:2])
        sources.append({"key": "businesses", "source": "LA City business registry", "status": "ok", "lines": [
            f"{bz['active']} active business registration{'s' if bz['active'] != 1 else ''} at this parcel"
            + (f" (mostly {top})" if top else ""),
            f"CoStar tenancies on record: {'about ' + str(on_record) + ' employees' if on_record else 'none with an employee count'}"]})
    models = len(rec.get("matterport_model_ids") or [])
    inside = bool(feeds.get("inside"))
    sources.append({"key": "matterport", "source": "Matterport scan", "status": "ok" if models else "missing", "lines": [
        f"{models} scanned space{'s' if models != 1 else ''} on record" if models else "no scan on record",
        "interior photos cached: Bob can walk it" if inside else "no interior photos cached"]})
    if city["list"]:
        nxt = city["next"] or {}
        lines = [f"on the city's {'non-ductile concrete' if city['list'] == 'concrete' else 'soft-story'} retrofit list",
                 ("retrofit not finished" if city["unfinished"] else "retrofit finished")
                 + (f"; next step: {nxt.get('what')} by {nxt['due'][:7]}" if nxt.get("due") else "")
                 + ("; past a deadline" if city["past_due"] else "")]
        sources.append({"key": "city_list", "source": "LA retrofit list", "status": "ok", "lines": lines})
        if city["list"] == "concrete" and mat not in ("concrete", "unknown"):
            conflicts.append({"field": "material", "a": {"source": "CoStar record", "value": mat},
                              "b": {"source": "LA retrofit list", "value": "concrete"}})
            sources[0]["status"] = sources[-1]["status"] = "conflict"
    else:
        sources.append({"key": "city_list", "source": "LA retrofit list", "status": "ok", "lines": ["not on a city retrofit list"]})
    sources.append({"key": "shakemap", "source": "USGS ShakeMap, 1994", "status": "ok" if mmi else "missing",
                    "lines": [f"felt intensity {mmi} (Modified Mercalli) in the Northridge quake" if mmi else "no shaking value here"]})
    try:
        mine = [c for c in cases.ordered() if str(c["property_id"]) == pid]
    except Exception:
        mine = []
    if mine:
        sources.append({"key": "cases", "source": "CoStar's open record cases", "status": "conflict", "lines": [
            f"{len(mine)} open case{'s' if len(mine) != 1 else ''}: " + ", ".join(sorted({c['case'].replace('_', ' ') for c in mine}))]})
    s = screen(pid, checks, notes)
    return {"pid": pid, "label": fortress._label(rec), "sources": sources, "conflicts": conflicts, "people": s["people"],
            # no tag colour before the quake: the card carries the score and the damage odds only (screen_building tags)
            "screening": {"score": s["score"], "fema_type": s["by_material"][0]["fema_type"], "p_damage": s["p_damage"]},
            "unknowns": ["exits and stairs: not in the data", "soil and irregularities: not in the data (left out of the score)"]}


@lru_cache(maxsize=2)
def _triage(scope: str = "district") -> dict[str, Any]:
    rows = []
    blds = fortress.district()["buildings"] if scope == "district" else fortress.city()["buildings"]
    for b in blds:
        try:
            s = screen(b["pid"])
        except Exception:
            continue
        rows.append({"pid": b["pid"], "label": s["label"], "people": s["people"]["at_stake"], "p_damage": s["p_damage"],
                     "at_risk": s["expected_at_risk"], "suggest": s["suggest"], "score": s["score"],
                     **({"x": b["x"], "z": b["z"]} if scope == "city" else {})})
    rows.sort(key=lambda r: -r["at_risk"])
    for i, r in enumerate(rows, 1):
        r["rank"] = i
    counts = {t: sum(r["suggest"] == t for r in rows) for t in ("green", "yellow", "red")}
    return {"scope": scope, "buildings": rows, "counts": counts, "people_at_stake": sum(r["people"] for r in rows),
            "expected_at_risk": round(sum(r["at_risk"] for r in rows)),
            "basis": "expected people at risk = chance of serious damage (screening score) x people inside; records only, "
                     "before today's evidence. After Northridge, about 6% of inspected buildings were posted red and 17% yellow."}


def triage(scope: str = "district") -> dict[str, Any]:
    """scope "district" (the play area, the agent's tool) or "city" (every LA building in the kit, for the map)."""
    return _triage("city" if scope == "city" else "district")


TAGS = {"green": "INSPECTED: lawful occupancy permitted", "yellow": "RESTRICTED USE: until a detailed evaluation",
        "red": "UNSAFE: do not enter"}


def tag(pid: str, tag_: str, checks: list[str] | tuple[str, ...] = (), notes: list[dict] | None = None) -> dict[str, Any]:
    t = str(tag_ or "").strip().lower()
    if t not in TAGS:
        return {"error": 'tag must be "green", "yellow" or "red"'}
    s = screen(pid, checks, notes)
    return {"pid": str(pid), "label": s["label"], "tag": t, "placard": TAGS[t], "suggested": s["suggest"],
            "agreed": t == s["suggest"], "people_at_stake": s["people"]["at_stake"], "p_damage": s["p_damage"],
            "simulated": True,
            "why": f"Simulated post-quake placard (game): {t.upper()}, {TAGS[t]}. The code suggested {s['suggest']}: "
                   f"{s['why']}. {DISCLAIMER}."}


RIGHT_TAG = {"none": "green", "slight": "green", "moderate": "yellow", "extensive": "red", "complete": "red"}
SERIOUS = ("extensive", "complete")
# Game parts (labelled): under ATC-20 Restricted Use (yellow) entry is limited, not barred, so some people are still
# exposed when the damage turns out serious; and a yellow posting keeps some people out of an undamaged building.
YELLOW_ENTRY = 0.10      # share of occupants still inside a yellow building (limited entry)
YELLOW_DISPLACED = 0.25  # share displaced by a yellow posting when the damage is none or slight


def _exposure(tag: str, state: str) -> tuple[float, float]:
    """(share of occupants exposed to serious damage, share displaced for nothing) for a tag and a damage state."""
    exposed = {"green": 1.0, "yellow": YELLOW_ENTRY, "red": 0.0}[tag] if state in SERIOUS else 0.0
    displaced = {"green": 0.0, "yellow": YELLOW_DISPLACED, "red": 1.0}[tag] if state in ("none", "slight") else 0.0
    return exposed, displaced


def aftershock(pid: str, day: int = 1) -> dict[str, Any]:
    """What the dawn aftershock reveals for one building: a seeded draw from the building's own damage odds (its
    records only: the HAZUS damage states for each material it may be, weighted by the records). What Bob checked
    changes his tag, never the building. Same building, same dawn."""
    s = screen(pid)
    mixed = {k: sum(r["odds"] * r["damage"][k] for r in s["by_material"]) for k in STATES}
    roll = random.Random(f"{SEED}:aftershock:{pid}" if day == 1 else f"{SEED}:day{day}:aftershock:{pid}").random()
    acc, state = 0.0, STATES[-1]
    for k in STATES:
        acc += mixed[k]
        if roll < acc:
            state = k
            break
    return {"screen": s, "state": state, "roll": round(roll, 3), "odds": {k: round(v, 3) for k, v in mixed.items()}}


def _desk_day_report(tags: list[dict], drafts: list[dict], day: int) -> dict[str, Any]:
    """Days 2+ have no aftershock: each tag is graded by the code's own screening. Expected people exposed and
    displaced for Bob's tag (on the building's records-only damage odds), next to every other tag's, and whether Bob's
    tag matches the code's suggestion. Nothing is rolled."""
    rows = []
    for t in tags:
        pid = str(t["pid"])
        a = aftershock(pid)  # only its odds are used here; its roll is ignored on these days
        s = a["screen"]
        n = s["people"]["at_stake"]
        expected = {tag: {"exposed": round(n * sum(a["odds"][k] * _exposure(tag, k)[0] for k in STATES)),
                          "displaced": round(n * sum(a["odds"][k] * _exposure(tag, k)[1] for k in STATES))}
                    for tag in ("green", "yellow", "red")}
        sug = t.get("suggested") or s["suggest"]
        mine = expected[t["tag"]]
        rows.append({"pid": pid, "label": s["label"], "tag": t["tag"], "suggested": sug, "agreed": t["tag"] == sug,
                     "damage": None, "outcome": "no aftershock today", "right_tag": None, "tag_right": None,
                     "people_at_stake": n, "people_safe": n - mine["exposed"], "people_exposed": mine["exposed"],
                     "people_displaced": mine["displaced"], "people_hurt": 0, "expected": expected,
                     "why": f"no aftershock today: graded by the screening. On this building's own odds a {t['tag']} tag "
                            f"leaves about {mine['exposed']} exposed and {mine['displaced']} displaced; the code suggested {sug}"})
    fixed = [d for d in drafts if (d.get("critic") or {}).get("status") == "reviewed" and (d["critic"].get("follows") is True)
             and str(d.get("text", "")).startswith("DRAFT")]
    return {"day": day, "aftershock": False, "buildings": rows,
            "people_safe": sum(r["people_safe"] for r in rows), "people_at_stake": sum(r["people_at_stake"] for r in rows),
            "people_displaced": sum(r["people_displaced"] for r in rows), "people_hurt": 0,
            "tags_matching_screening": sum(r["agreed"] for r in rows), "tags_right": None, "tags": len(rows),
            "records_fixed": len(fixed),
            "records": [{"label": d.get("label"), "verdict": d.get("label_verdict"),
                         "critic": (d.get("critic") or {}).get("status")} for d in drafts],
            "rule": "No aftershock on this day: people safe, exposed and displaced are EXPECTED values for Bob's tag on the "
                    "building's records-only damage odds (HAZUS at its 1994 shaking); the tag is compared with the code's "
                    "suggestion.",
            "disclaimer": f"{DISCLAIMER}."}


def shift_report(tags: list[dict], evidence_by_pid: dict[str, tuple[list[str], list[dict]]], drafts: list[dict],
                 day: int = 1) -> dict[str, Any]:
    """Dawn: the aftershock reveals each tagged building's damage (seeded, from the building's own odds) and tests the
    tag against the ATC-20 posting that damage calls for (none/slight green, moderate yellow, extensive/complete red).
    People exposed to serious damage: all of them under green, a limited-entry share under yellow, none under red; they
    are hurt in the game at HAZUS indoor rates. Displaced for nothing: all under red, a share under yellow, when the
    damage is none or slight. Each row also carries the expected outcome of every tag (decision quality, not luck).
    Records fixed: correction drafts the reviewer agreed with."""
    if day > 1:
        return _desk_day_report(tags, drafts, day)
    rows, safe, stake, displaced, hurt, right = [], 0, 0, 0, 0.0, 0
    for t in tags:
        pid = str(t["pid"])
        a = aftershock(pid, day)
        s, state = a["screen"], a["state"]
        n = s["people"]["at_stake"]
        cls = s["by_material"][0]["hazus_class"]
        rates = INJURY["URM" if cls.startswith("URM") else "W" if cls.startswith("W") else "C"]
        if state == "complete":
            pc = P_COLLAPSE[cls]
            per = sum((1 - pc) * x + pc * y for x, y in zip(rates["complete"], rates["collapse"])) / 100
        else:
            per = sum(rates.get(state, (0, 0, 0, 0))) / 100
        ex, dp = _exposure(t["tag"], state)
        exposed, disp = round(n * ex), round(n * dp)
        h = round(exposed * per)
        kept = n - exposed
        ok = t["tag"] == RIGHT_TAG[state]
        expected = {tag: {"exposed": round(n * sum(a["odds"][k] * _exposure(tag, k)[0] for k in STATES)),
                          "displaced": round(n * sum(a["odds"][k] * _exposure(tag, k)[1] for k in STATES))}
                    for tag in ("green", "yellow", "red")}
        why = f"{state} damage (roll {a['roll']:.3f} on the building's own odds)"
        why += (f"; {exposed} people were inside" if exposed else
                "; the tag kept people out" if state in SERIOUS else
                f"; {disp} people were kept out for nothing" if disp else "")
        rows.append({"pid": pid, "label": s["label"], "tag": t["tag"], "damage": state,
                     "outcome": "damaged" if state in SERIOUS else "held", "right_tag": RIGHT_TAG[state], "tag_right": ok,
                     "roll": a["roll"], "odds": a["odds"], "people_at_stake": n, "people_safe": kept,
                     "people_exposed": exposed, "people_displaced": disp, "people_hurt": h, "expected": expected,
                     "why": why})
        safe, stake, displaced, hurt, right = safe + kept, stake + n, displaced + disp, hurt + h, right + ok
    fixed = [d for d in drafts if (d.get("critic") or {}).get("status") == "reviewed" and (d["critic"].get("follows") is True)
             and str(d.get("text", "")).startswith("DRAFT")]
    return {"buildings": rows, "people_safe": safe, "people_at_stake": stake, "people_displaced": displaced,
            "people_hurt": round(hurt), "tags_right": right, "tags": len(rows), "records_fixed": len(fixed),
            "records": [{"label": d.get("label"), "verdict": d.get("label_verdict"),
                         "critic": (d.get("critic") or {}).get("status")} for d in drafts],
            "rule": "ATC-20 posting for the revealed damage: none/slight green, moderate yellow, extensive/complete red. "
                    f"Yellow allows limited entry ({round(YELLOW_ENTRY * 100)}% still inside) and displaces "
                    f"{round(YELLOW_DISPLACED * 100)}% when the damage is minor (game shares). People hurt use HAZUS indoor "
                    "casualty rates (game). 'expected' gives every tag's average outcome on the building's own odds.",
            "disclaimer": f"{DISCLAIMER}."}


# ---------------------------------------------------------------- Bob's days (one real hero building and suite each)
# Each later day is another in-district building with a real CoStar-vs-city material disagreement, a door (Bob can walk
# in), Matterport scans, and an office suite case with a door. Day 1 is the recorded stage shift, unchanged.
DAYS = [
    {"day": 1, "hero_pid": "6375735", "office_pid": "254167", "suite": "1100"},
    {"day": 2, "hero_pid": "256445", "office_pid": "249218", "suite": "404"},
    {"day": 3, "hero_pid": "7376255", "office_pid": "254167", "suite": "1400"},
    {"day": 4, "hero_pid": "7762448", "office_pid": "249218", "suite": "401402"},  # no outline: drawn as a box
]
_DAY_RE = __import__("re").compile(r"^start bob's shift(?:[,:]?\s*day\s*(\d+))?\.?$", __import__("re").I)


def parse_day(text: str) -> int | None:
    """"Start Bob's shift" is day 1; "Start Bob's shift, day 3" (or ": day 3") is day 3; anything else is None."""
    m = _DAY_RE.match(" ".join(str(text or "").split()))
    if not m:
        return None
    d = int(m.group(1) or 1)
    return d if 1 <= d <= len(DAYS) else None


def day_pins() -> set[tuple[str, str | None]]:
    return {(d["hero_pid"], None) for d in DAYS} | {(d["office_pid"], d["suite"]) for d in DAYS}


def days() -> dict[str, Any]:
    out = []
    for d in DAYS:
        hero = fortress.building(d["hero_pid"]) or {}
        office = fortress.building(d["office_pid"]) or {}
        s = screen(d["hero_pid"])
        rec = costar.get(d["hero_pid"])
        out.append({**d, "hero_label": hero.get("label"), "office_label": office.get("label"),
                    "hero_door": hero.get("door"), "office_door": office.get("door"),
                    "disagreement": f"CoStar records {fortress._material(rec)}; the city's retrofit list says concrete",
                    "people_at_stake": s["people"]["at_stake"], "records_only_suggest": s["suggest"]})
    return {"n": len(DAYS), "days": out}


def day_inbox(day: int) -> dict[str, Any]:
    """Day k's inbox: the same shape as Last Stand's night_cases, for that day's office suite and hero building."""
    from app import cases, evidence

    d = DAYS[day - 1]
    pins = {(d["hero_pid"], None), (d["office_pid"], d["suite"])}
    ordered = cases.ordered()
    g = fortress.GROUND
    inside = 0
    picked = []
    for n, c in enumerate(ordered, 1):
        b = fortress.building(c["property_id"])
        if b and g["x0"] - fortress.PLAY_PAD_M <= b["x"] <= g["x1"] + fortress.PLAY_PAD_M and \
                g["z0"] - fortress.PLAY_PAD_M <= b["z"] <= g["z1"] + fortress.PLAY_PAD_M:
            inside += 1
        key = (str(c["property_id"]), c.get("suite") if c["case"] == "ghost_tenant" else None)
        if b and key in pins and c["case"] in ("ghost_tenant", "material_conflict"):
            picked.append((n, c, b))
            pins.discard(key)
    today = []
    for n, c, b in picked:
        suite = c.get("suite") if c["case"] == "ghost_tenant" else None
        case = next((k for k in evidence.open_case(c["property_id"], suite).get("cases") or [] if k["case"] == c["case"]), None)
        if c["case"] == "ghost_tenant":
            label = f"suite {suite}, {b['label']}"
            stakes = f"{(c.get('label') or '').split(': ', 1)[-1] or 'a tenant'} on record; the suite is listed for lease"
        else:
            label = b["label"]
            stakes = f"an unfinished city concrete retrofit order; CoStar records {(c.get('material') or 'another material').lower()}"
        today.append({"n": n, "case": c["case"], "property_id": c["property_id"], "suite": suite, "label": label,
                      "question": case["question"] if case else None, "stakes": stakes})
    return {"day": day, "of": len(DAYS), "total": len(ordered), "in_area": inside, "cases": today}

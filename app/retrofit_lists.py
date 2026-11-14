"""Los Angeles' mandatory seismic retrofit lists, matched to CoStar buildings locally.

LA ordered two kinds of buildings to be retrofitted: wood soft-story apartments (Ordinance 183893) and
non-ductile concrete buildings (Ordinance 183893's concrete twin, 25-year program). The city publishes both
lists and the permits pulled for the work (scripts/fetch_public.py caches them in fixtures/public/).
This module matches them to CoStar kit buildings by normalized street address + ZIP, on this machine only.

Code builds the evidence and the four hypotheses; the model only explains them:
  unfinished       on a list, not finished, built before 1978          -> the work is really outstanding
  stale_entry      on a list, not finished, but built 1978 or later    -> the listed building was likely replaced
  material_conflict on the concrete list, but CoStar records another material -> flag for a researcher
                   (never "the record is wrong": either source can be out of date)
  not_proven_safe  CoStar says pre-1977 reinforced concrete, but it's not on the concrete list
                   -> "not on the list" does not mean "safe"
"""

from __future__ import annotations

import collections
import json
import re
from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import Any

from app import costar

PUBLIC = Path(__file__).resolve().parent.parent / "fixtures" / "public"
STALE_YEAR = 1978  # the soft-story ordinance targets wood buildings permitted before 1978
OLD_CONCRETE_YEAR = 1977  # the concrete ordinance targets buildings permitted before Jan 13, 1977

STEP_WHAT = {"step_1": "step 1", "step_2": "step 2", "step_3": "step 3"}
SOFT_STORY_STEPS = {"step_1": "submit retrofit plans", "step_2": "get the retrofit permit", "step_3": "finish the work (certificate of compliance)"}
CONCRETE_STEPS = {"step_1": "submit the building checklist", "step_2": "submit retrofit plans", "step_3": "finish the work"}

DIRS = {"N", "S", "E", "W", "NORTH", "SOUTH", "EAST", "WEST"}
ABBR = {"AVENUE": "AVE", "STREET": "ST", "BOULEVARD": "BLVD", "DRIVE": "DR", "PLACE": "PL", "ROAD": "RD",
        "LANE": "LN", "COURT": "CT", "TERRACE": "TER", "PARKWAY": "PKWY", "CIRCLE": "CIR"}


class PublicDataMissing(RuntimeError):
    pass


def norm(s: str) -> str:
    s = re.sub(r"[^A-Z0-9 ]", " ", s.upper())
    return " ".join(ABBR.get(t, t) for t in s.split() if t not in DIRS)


def key_addr(a: str | None) -> str | None:
    """'5117 N WOODMAN AVE' or '1800-1810 Century Park E' -> '5117 WOODMAN AVE' / '1800 CENTURY PARK'."""
    a = (a or "").split(",")[0]
    m = re.match(r"\s*(\d+)(?:\s*-\s*\d+)?\s+(.*)", a)
    return norm(m.group(1) + " " + m.group(2)) if m else None


def _load(name: str) -> list[dict[str, Any]]:
    p = PUBLIC / f"{name}.json"
    if not p.exists():
        raise PublicDataMissing(f"{p} is missing: run python scripts/fetch_public.py once (needs the internet)")
    return json.loads(p.read_text())


def _index(rows: list[dict[str, Any]], addr: str, zipf: str) -> dict[tuple[str, str], list[dict[str, Any]]]:
    out: dict[tuple[str, str], list[dict[str, Any]]] = collections.defaultdict(list)
    for r in rows:
        k = key_addr(r.get(addr))
        if k:
            out[(k, (r.get(zipf) or "")[:5])].append(r)
    return out


@lru_cache(maxsize=1)
def _lists() -> tuple[dict, dict, dict]:
    return (_index(_load("softstory"), "address", "zip"),
            _index(_load("ndc"), "address", "zip"),
            _index(_load("retrofit_permits"), "primary_address", "zip_code"))


def _day(v: str | None) -> str | None:
    return v[:10] if v else None


def _steps(due: dict[str, str | None], done: dict[str, str | None], today: str) -> list[dict[str, Any]]:
    """Each ordinance step with its deadline and the record that shows it done, if any."""
    out = []
    for step in ("step_1", "step_2", "step_3"):
        d, ok = due.get(step), done.get(step)
        state = "done" if ok else ("overdue" if d and d < today else "not_due_yet")
        out.append({"step": step, "what": STEP_WHAT[step], "due": d, "done": ok, "state": state})
    return out


def _with_steps(entry: dict[str, Any], done: dict[str, str | None], today: str, what: dict[str, str]) -> dict[str, Any]:
    entry["steps"] = [dict(s, what=what[s["step"]]) for s in _steps(entry["due"], done, today)]
    entry["overdue_steps"] = [s["step"] for s in entry["steps"] if s["state"] == "overdue"]
    return entry


def _soft_story(r: dict[str, Any], today: str) -> dict[str, Any]:
    e = {"list": "soft_story", "address": r.get("address"), "order_date": _day(r.get("otc_date")),
            "permit": r.get("permit"), "plans_submitted": _day(r.get("submitted")), "permit_issued": _day(r.get("issued")),
            "completed": _day(r.get("cofc_issued")),  # certificate of compliance
            "due": {"step_1": _day(r.get("step_1_compl_date")), "step_2": _day(r.get("step_2_compl_date")),
                    "step_3": _day(r.get("step_3_compl_date"))}}
    return _with_steps(e, {"step_1": _day(r.get("submitted")), "step_2": _day(r.get("issued")), "step_3": _day(r.get("cofc_issued"))},
                       today, SOFT_STORY_STEPS)


def _concrete(r: dict[str, Any], today: str) -> dict[str, Any]:
    e = {"list": "non_ductile_concrete", "address": r.get("address"), "order_date": _day(r.get("otc_date")),
            "checklist": _day(r.get("checklist")), "plans_submitted": _day(r.get("plan_submittal")),
            "completed": _day(r.get("work_completion")),
            "due": {"step_1": _day(r.get("step_1_due_date")), "step_2": _day(r.get("step_2_due_date")),
                    "step_3": _day(r.get("step_3_due_date"))}}
    return _with_steps(e, {"step_1": _day(r.get("checklist")), "step_2": _day(r.get("plan_submittal")), "step_3": _day(r.get("work_completion"))},
                       today, CONCRETE_STEPS)


def _permit(r: dict[str, Any]) -> dict[str, Any]:
    return {"issued": _day(r.get("issue_date")), "type": r.get("permit_type"), "status": r.get("status_desc"),
            "work": (r.get("work_desc") or "")[:200]}


def match(rec: dict[str, Any]) -> tuple[list[dict], list[dict], list[dict]]:
    ss, ndc, pm = _lists()
    keys = {(k, rec.get("zip") or "") for k in (key_addr(a) for a in rec.get("street_addresses") or []) if k}
    pick = lambda idx: [x for k in sorted(keys) for x in idx.get(k, [])]  # noqa: E731
    return pick(ss), pick(ndc), pick(pm)


def assess(rec: dict[str, Any], today: str | None = None) -> dict[str, Any]:
    """Seismic-retrofit status of one CoStar record (LA only)."""
    out: dict[str, Any] = {"property_id": rec["property_id"], "city": rec.get("city"), "address": rec.get("address"),
                           "year_built": rec.get("year_built"), "stories": rec.get("stories"), "units": rec.get("units"),
                           "costar_material": rec.get("construction_material"), "source": "LA DBS retrofit lists + permits (data.lacity.org)",
                           "synthetic": bool(rec.get("synthetic"))}
    if (rec.get("city") or "").strip().lower() != "los angeles":
        out.update(status="not_applicable", lists=[], hypotheses=[], note="LA's retrofit ordinances cover the City of Los Angeles only.")
        return out
    ss, ndc, pm = match(rec)
    today = today or date.today().isoformat()
    entries = [_soft_story(r, today) for r in ss] + [_concrete(r, today) for r in ndc]
    finished = bool(entries) and (not ss or any(r.get("cofc_issued") for r in ss)) and (not ndc or any(r.get("work_completion") for r in ndc))
    permits = sorted((_permit(r) for r in pm), key=lambda p: p["issued"] or "", reverse=True)
    yb, mat = rec.get("year_built"), rec.get("construction_material")
    hyps: list[dict[str, Any]] = []
    if entries and not finished:
        if yb and yb >= STALE_YEAR:
            hyps.append({"key": "stale_entry", "status": "suspected",
                         "evidence": f"on the list but CoStar says built {yb}, after the ordinance's cutoff; the listed building may have been replaced",
                         "next_check": "look for demolition or new-building permits at this address"})
        else:
            overdue = [f"{e['list'].replace('_', ' ')} {s['step'].replace('_', ' ')} ({s['what']}, due {s['due']})"
                       for e in entries for s in e["steps"] if s["state"] == "overdue"]
            hyps.append({"key": "unfinished", "status": "supported", "past_due": bool(overdue),
                         "evidence": f"ordered to retrofit{' on ' + entries[0]['order_date'] if entries[0].get('order_date') else ''}; no completion on record"
                                     + (f"; built {yb}" if yb else "")
                                     + (f"; past due: {'; '.join(overdue)}" if overdue else "; no deadline has passed yet")})
    if ndc and mat not in (None, "Unknown", "ReinforcedConcrete"):
        hyps.append({"key": "material_conflict", "status": "flag_for_researcher",
                     "evidence": f"the city lists it as non-ductile concrete; CoStar records {mat}. One of the two sources is out of date or describes a different part of the site."})
    if not ndc and mat == "ReinforcedConcrete" and yb and yb < OLD_CONCRETE_YEAR:
        hyps.append({"key": "not_proven_safe", "status": "open",
                     "evidence": f"CoStar records reinforced concrete built {yb}, but it is not on the concrete list: not on the list does not mean safe"})
    recent = [p for p in permits if (p["issued"] or "") >= "2020"]
    if recent and not finished:
        hyps.append({"key": "work_underway", "status": "possible",
                     "evidence": f"{len(recent)} retrofit permit(s) since 2020, latest {recent[0]['issued']} ({recent[0]['status']})"})
    out.update(status=("finished" if finished else "unfinished") if entries else "not_listed",
               lists=entries, permits=permits[:5], hypotheses=hyps)
    return out


def status(property_id: str) -> dict[str, Any]:
    return assess(costar.get(property_id))


def la_records() -> list[dict[str, Any]]:
    return [dict(r) for r in costar._index().values() if (r.get("city") or "").strip().lower() == "los angeles"]


def portfolio() -> list[dict[str, Any]]:
    """Every LA kit building with a seismic finding (on a list, or older concrete off the list)."""
    out = []
    for rec in la_records():
        a = assess(rec)
        if a["lists"] or a["hypotheses"]:
            out.append(a)
    return out


def stats() -> dict[str, Any]:
    recs = la_records()
    rows = [assess(r) for r in recs]
    listed = [a for a in rows if a["lists"]]
    unfinished = [a for a in listed if a["status"] == "unfinished"]
    stale = [a for a in unfinished if any(h["key"] == "stale_entry" for h in a["hypotheses"])]
    real = [a for a in unfinished if a not in stale]
    concrete_listed = [a for a in listed if any(e["list"] == "non_ductile_concrete" for e in a["lists"])]
    old_concrete = [a for a in rows if a["costar_material"] == "ReinforcedConcrete" and a["year_built"] and a["year_built"] < OLD_CONCRETE_YEAR]
    return {
        "la_kit_buildings": len(recs),
        "on_a_retrofit_list": len(listed),
        "unfinished": len(unfinished),
        "unfinished_stale_entries": len(stale),
        "unfinished_real": len(real),
        "unfinished_real_units": sum(a["units"] or 0 for a in real),
        "unfinished_all_units": sum(a["units"] or 0 for a in unfinished),
        "concrete_list_matches": len(concrete_listed),
        "concrete_list_matches_recorded_concrete": sum(a["costar_material"] == "ReinforcedConcrete" for a in concrete_listed),
        "concrete_list_matches_by_material": dict(collections.Counter(a["costar_material"] for a in concrete_listed)),
        "older_concrete": len(old_concrete),
        "older_concrete_on_list": sum(bool([e for e in a["lists"] if e["list"] == "non_ductile_concrete"]) for a in old_concrete),
        "unfinished_real_past_due": sum(any(h.get("past_due") for h in a["hypotheses"]) for a in real),
        "unfinished_with_permit_since_2020": sum(any((p["issued"] or "") >= "2020" for p in a["permits"]) for a in unfinished),
    }

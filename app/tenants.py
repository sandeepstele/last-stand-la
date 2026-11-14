"""Ghost tenants: suites CoStar records as occupied that are listed for lease right now.

Matched locally from the CoStar kit (mirrors the joins verified Sat Nov 14):
  - a current tenancy is a location-occupancy record with no toDate; its suite comes from
    company-detail[tenantLocationId].suite (occupancy spaces carry no suite)
  - a live listing is a commercial-listing-summary forLeaseSummary space with no dateOffMarket
  - a suite tour is a commercial-property attachment whose caption names the suite and that has a
    Matterport videoKey; originationDate is the tour date (the Matterport model's own `created`
    is the event's import date, not the capture date)

Company names are used ONLY inside this module to follow a company's trail to other buildings;
nothing this module returns carries a name. People see "a 21-person accounting office".
"""

from __future__ import annotations

import collections
import json
import re
from datetime import date
from functools import lru_cache
from typing import Any

from app import costar

INDUSTRY = {0: "office", 1: "accounting office", 2: "transportation company", 3: "engineering or architecture firm",
            4: "real estate firm", 5: "manufacturer", 6: "retail or wholesale business", 7: "financial firm",
            8: "technology firm", 9: "public agency", 10: "utilities or resources company", 11: "media or information firm",
            12: "professional services firm", 13: "personal services business"}
SPACE_TYPE = {0: "unknown", 1: "relet", 2: "new", 3: "sublet", 4: "assignment"}
STATUS = {1: "active", 2: "out of business", 3: "shell company", 4: "moved or merged"}


def norm_suite(s: Any) -> str | None:
    if not s:
        return None
    s = re.sub(r"\b(SUITE|STE|UNIT|NO|FLOOR|FL)\b", "", str(s).upper())
    s = re.sub(r"[^A-Z0-9]", "", s)
    return s.lstrip("0") or None


def _lines(name: str):
    with open(costar.kit_dir() / "data" / f"{name}.jsonl") as f:
        for line in f:
            if line.strip():
                yield json.loads(line)


@lru_cache(maxsize=1)
def _index() -> dict[str, Any]:
    props: dict[int, dict] = {}
    tours: dict[tuple, dict] = {}
    for r in _lines("commercial-property"):
        props[r["id"]] = {"type": r.get("propertyType"), "city": (r.get("primaryAddress") or {}).get("city")}
        for a in r.get("attachments") or []:
            m = re.search(r"(?:suite|ste|unit|#)\s*([A-Za-z0-9-]+)", a.get("caption") or "", re.I)
            if a.get("videoKey") and m:
                tours[(r["id"], norm_suite(m.group(1)))] = {"model": a["videoKey"], "date": (a.get("originationDate") or "")[:10]}
    comp: dict[int, dict] = {}
    for c in _lines("company-detail"):
        comp[c["id"]] = {"name": (c.get("name") or "").strip().upper(), "suite": norm_suite(c.get("suite")),
                         "employees": c.get("numEmployees"), "status": c.get("businessStatus")}
    current: dict[tuple, list] = collections.defaultdict(list)
    by_company: dict[str, list] = collections.defaultdict(list)
    for r in _lines("location-occupancy"):
        p, c = props.get(r.get("propertyId")), comp.get(r.get("tenantLocationId"))
        if not p or p["type"] == 11 or not c:
            continue
        rec = {"pid": r["propertyId"], "suite": c["suite"], "from": (r.get("fromDate") or "")[:10], "to": (r.get("toDate") or "")[:10],
               "industry": r.get("industryType") or 0, "employees": c["employees"], "status": c["status"],
               "lease_expires": ((r.get("leaseDeal") or {}).get("expirationDate") or "")[:10], "_company": c["name"],
               "sqft": sum((s.get("squareFeetOccupied") or 0) for s in r.get("spaces") or [])}
        if c["name"]:
            by_company[c["name"]].append(rec)
        if not r.get("toDate") and rec["suite"]:
            current[(rec["pid"], rec["suite"])].append(rec)
    live: dict[tuple, list] = collections.defaultdict(list)
    for r in _lines("commercial-listing-summary"):
        for sp in (r.get("forLeaseSummary") or {}).get("spaces") or []:
            if sp.get("dateOffMarket"):
                continue
            pid, su = sp.get("propertyId") or r.get("propertyId"), norm_suite(sp.get("suite"))
            if su:
                live[(pid, su)].append({"type": SPACE_TYPE.get(sp.get("spaceType"), "unknown"), "on_market": (sp.get("dateOnMarket") or "")[:10],
                                        "available": (sp.get("availableOnDate") or "")[:10], "sqft": sp.get("squareFeetMax") or sp.get("squareFeet"),
                                        "lease_pending": bool(sp.get("isLeasePending"))})
    return {"props": props, "tours": tours, "current": current, "live": live, "by_company": by_company}


def describe(t: dict) -> str:
    n = t.get("employees")
    kind = INDUSTRY.get(t.get("industry") or 0, "office")
    if n:
        return f"{'an' if str(n).startswith('8') or n in (11, 18) else 'a'} {n}-person {kind}"
    return f"an {kind}" if kind[0] in "aeiou" else f"a {kind}"


def _public(t: dict) -> dict:
    return {"tenant": describe(t), "employees": t.get("employees"), "tenant_since": t["from"] or None,
            "lease_expires": t["lease_expires"] or None, "business_status": STATUS.get(t.get("status"), "unknown"), "sqft": t["sqft"] or None}


def suite_facts(pid: int | str, suite: str) -> dict[str, Any]:
    ix = _index()
    pid_i, su = int(pid), norm_suite(suite)
    tenants = ix["current"].get((pid_i, su), [])
    listings = ix["live"].get((pid_i, su), [])
    on_market = min((x["on_market"] for x in listings if x["on_market"]), default=None)
    trail_elsewhere, trail_same = [], []
    for t in tenants:
        for o in ix["by_company"].get(t["_company"], []) if t["_company"] else []:
            if o is t or (on_market and o["from"] < on_market):
                continue
            (trail_same if o["pid"] == pid_i else trail_elsewhere).append(
                {"since": o["from"], "city": ix["props"].get(o["pid"], {}).get("city"), "same_building": o["pid"] == pid_i,
                 "suite": o["suite"] if o["pid"] == pid_i else None})
    return {"property_id": str(pid_i), "suite": su, "city": ix["props"].get(pid_i, {}).get("city"),
            "tenants": [_public(t) for t in tenants], "listings": listings, "listed_since": on_market,
            "tour": ix["tours"].get((pid_i, su)), "trail_elsewhere": trail_elsewhere, "trail_same_building": trail_same}


def candidates() -> list[dict[str, Any]]:
    ix = _index()
    out = []
    for key in ix["current"]:
        if key in ix["live"]:
            f = suite_facts(*key)
            for t in f["tenants"]:
                sublet = any(x["type"] in ("sublet", "assignment") for x in f["listings"])
                stale = bool(f["listed_since"] and t["tenant_since"] and t["tenant_since"] > f["listed_since"])
                out.append({**{k: f[k] for k in ("property_id", "suite", "city", "listed_since", "tour")}, **t,
                            "sublet": sublet, "tenant_after_listing": stale, "moved_elsewhere": bool(f["trail_elsewhere"])})
    return out


def queue_rows() -> list[dict[str, Any]]:
    rows = []
    for c in candidates():
        if c["sublet"]:
            continue  # a sublet listing is the tenant's own move, not a ghost
        months = 0
        if c["listed_since"]:
            y, m = int(c["listed_since"][:4]), int(c["listed_since"][5:7])
            months = (date.today().year - y) * 12 + date.today().month - m
        rows.append({"case": "ghost_tenant", "property_id": c["property_id"], "suite": c["suite"],
                     "address": (costar.get(c["property_id"]).get("address") if c["property_id"] else None),
                     "label": f"suite {c['suite']}: {c['tenant']}", "past_due": False,
                     "stakes": (c["employees"] or 0) / 25 + (1 if c["tour"] else 0) + months / 12 - (3 if c["tenant_after_listing"] else 0)})
    return rows


def stats() -> dict[str, Any]:
    cs = candidates()
    pairs = {(c["property_id"], c["suite"]) for c in cs}
    return {"suites": len(pairs), "employees_on_record": sum(c["employees"] or 0 for c in cs),
            "sublet": len({(c["property_id"], c["suite"]) for c in cs if c["sublet"]}),
            "tenant_after_listing": len({(c["property_id"], c["suite"]) for c in cs if c["tenant_after_listing"] and not c["sublet"]}),
            "with_tour": len({(c["property_id"], c["suite"]) for c in cs if c["tour"]}),
            "moved_elsewhere": len({(c["property_id"], c["suite"]) for c in cs if c["moved_elsewhere"]})}

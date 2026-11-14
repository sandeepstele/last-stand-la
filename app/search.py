"""Search the overnight solar screen, for questions that name no building.

"Best roofs in Houston", "warehouses we could sign now": the agent calls find_buildings, which filters
and sorts the rows scripts/solar_screen.py wrote to fixtures/solar/ranking.json (CoStar + Vexcel + NREL +
EIA + EPA, already joined). Nothing is recomputed here. The ranking is derived from licensed data, so it
is gitignored; on a machine without it the tool says so instead of guessing.
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any

from app import costar

DEFAULT_PATH = Path(__file__).resolve().parent.parent / "fixtures" / "solar" / "ranking.json"
MAX_LIMIT = 10

CITY_ALIASES = {"la": "los angeles", "l.a.": "los angeles", "hou": "houston", "htx": "houston"}
TYPE_ALIASES = {
    "office": "Office", "offices": "Office",
    "industrial": "Industrial", "warehouse": "Industrial", "warehouses": "Industrial",
    "distribution": "Industrial", "logistics": "Industrial", "factory": "Industrial",
    "retail": "GeneralRetail", "generalretail": "GeneralRetail", "store": "GeneralRetail", "stores": "GeneralRetail",
    "shop": "GeneralRetail", "shopping": "GeneralRetail",
    "flex": "Flex",
    "hotel": "Hospitality", "hotels": "Hospitality", "hospitality": "Hospitality",
    "healthcare": "Healthcare", "medical": "Healthcare", "hospital": "Healthcare",
    "specialty": "Specialty",
}
READINESS_ALIASES = {"ready": "ready", "readynow": "ready", "now": "ready", "inspect": "inspect",
                     "reroof": "reroof_first", "rerooffirst": "reroof_first", "unknown": "unknown"}
DEAL_FITS = {"strong": {"strong"}, "moderate": {"moderate"}, "weak": {"weak"}, "unknown": {"unknown"},
             "workable": {"strong", "moderate"}}
# keys are _key()-normalized (lowercase, no spaces or underscores)
SORTS = {"priority": "priority", "systemkw": "system_kw", "kw": "system_kw", "size": "system_kw",
         "annualkwh": "annual_kwh", "energy": "annual_kwh", "mwh": "annual_kwh",
         "co2": "co2_t_per_year", "co2tperyear": "co2_t_per_year", "carbon": "co2_t_per_year"}


def ranking_path() -> Path:
    return Path(os.environ.get("RADAR_RANKING_PATH") or DEFAULT_PATH)


@lru_cache(maxsize=4)
def _load(path: str, mtime: float) -> list[dict[str, Any]]:
    return json.loads(Path(path).read_text())


def load() -> tuple[list[dict[str, Any]], float] | None:
    p = ranking_path()
    if not p.exists():
        return None
    mtime = p.stat().st_mtime
    return _load(str(p), mtime), mtime


def _key(s: str) -> str:
    return "".join(ch for ch in s.lower() if ch.isalnum() or ch == ".")


def norm_city(city: str | None) -> str | None:
    """'Houston', 'houston', 'Houston, TX', 'LA' -> 'houston' / 'los angeles'."""
    if not city or not city.strip():
        return None
    c = " ".join(city.strip().lower().replace(",", " ").split())
    for suffix in (" tx", " texas", " ca", " california"):
        if c.endswith(suffix):
            c = c[: -len(suffix)].strip()
    return CITY_ALIASES.get(c, c)


def _bad(field: str, value: str, allowed: list[str]) -> dict[str, Any]:
    return {"status": "bad_filter", "detail": f"{field}={value!r} is not a known value", "field": field, "allowed": allowed}


def _address(pid: str) -> str | None:
    try:
        return costar.get(pid).get("address")
    except Exception:  # kit missing or id unknown: the list still works without addresses
        return None


def _row(r: dict[str, Any]) -> dict[str, Any]:
    c, s = r["costar"], r["screen"]
    return {
        "property_id": c["property_id"],
        "address": _address(c["property_id"]),
        "city": (c.get("city") or "").title() or None,
        "property_type": c.get("property_type"),
        "gba_sqft": c.get("gba_sqft"),
        "stories": c.get("stories"),
        "year_built": c.get("year_built"),
        "system_kw": s.get("system_kw"),
        "annual_mwh": round(s["annual_kwh"] / 1000) if s.get("annual_kwh") is not None else None,
        "co2_t_per_year": s.get("co2_t_per_year"),
        "load_matched_kw": s.get("load_matched_kw"),
        "readiness": s.get("readiness"),
        "readiness_reasons": (s.get("readiness_reasons") or [])[:3],
        "deal_fit": s.get("deal_fit"),
        "deal_reasons": (s.get("deal_reasons") or [])[:3],
        "headline": s.get("headline"),
    }


def find(city: str | None = None, property_type: str | None = None, readiness: str | None = None,
         deal_fit: str | None = None, min_kw: float | None = None, sort: str | None = "priority",
         limit: int | None = 5) -> dict[str, Any]:
    loaded = load()
    if loaded is None:
        return {"status": "no_ranking",
                "detail": "The overnight screen hasn't run on this machine (python scripts/solar_screen.py --limit 1000)."}
    rows, mtime = loaded

    filters: dict[str, Any] = {}
    want_city = norm_city(city)
    if want_city:
        filters["city"] = want_city
    want_type = None
    if property_type and property_type.strip():
        want_type = TYPE_ALIASES.get(_key(property_type))
        if want_type is None:
            return _bad("property_type", property_type, sorted(set(TYPE_ALIASES.values())))
        filters["property_type"] = want_type
    want_ready = None
    if readiness and readiness.strip():
        want_ready = READINESS_ALIASES.get(_key(readiness).replace(".", ""))
        if want_ready is None:
            return _bad("readiness", readiness, ["ready", "inspect", "reroof_first", "unknown"])
        filters["readiness"] = want_ready
    want_deal = None
    if deal_fit and deal_fit.strip():
        want_deal = DEAL_FITS.get(_key(deal_fit))
        if want_deal is None:
            return _bad("deal_fit", deal_fit, list(DEAL_FITS))
        filters["deal_fit"] = deal_fit.strip().lower()
    if min_kw:
        filters["min_kw"] = min_kw
    sort_key = SORTS.get(_key(sort or "priority"))
    if sort_key is None:
        return _bad("sort", str(sort), ["priority", "system_kw", "annual_kwh", "co2"])
    n = max(1, min(int(limit or 5), MAX_LIMIT))

    screened = [r for r in rows if r["screen"].get("status") == "screened"]
    match = [
        r for r in screened
        if (want_city is None or norm_city(r["costar"].get("city")) == want_city)
        and (want_type is None or r["costar"].get("property_type") == want_type)
        and (want_ready is None or r["screen"].get("readiness") == want_ready)
        and (want_deal is None or r["screen"].get("deal_fit") in want_deal)
        and (not min_kw or (r["screen"].get("system_kw") or 0) >= min_kw)
    ]
    match.sort(key=lambda r: -(r["screen"].get(sort_key) or 0))
    return {
        "status": "ok",
        "matched": len(match),
        "screened": len(screened),
        "not_sized": len(rows) - len(screened),
        "filters": filters,
        "sort": sort_key,
        "results": [_row(r) for r in match[:n]],
        "source": "overnight solar screen of every non-apartment CoStar building (fixtures/solar/ranking.json)",
        "screened_at": datetime.fromtimestamp(mtime, UTC).isoformat(timespec="minutes"),
        "synthetic": False,
    }

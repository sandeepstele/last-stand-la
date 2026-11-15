"""Public LA layers for Bob's district, matched to kit buildings locally (scripts/fetch_county.py downloads them once).

  assessor(pid)   the LA County Assessor parcel under the CoStar point: year built, effective year, building area,
                  use and design type (the largest-area parcel when air-rights or condo parcels overlap)
  lariac(pid)     the LARIAC building outline under the CoStar point: roof height (feet; 2008 survey imagery)
  businesses(pid) LA City's active business registrations whose own map point falls in that parcel: a count and
                  industries only (names are never downloaded)

Nothing is sent anywhere at play time: these read fixtures/public/ only. A building outside the downloaded box, or with
no parcel under its point, simply has no county line on its card.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from app import costar

PUBLIC = Path(__file__).resolve().parent.parent / "fixtures" / "public"
FT_TO_M = 0.3048


def _load(name: str) -> dict[str, Any] | None:
    p = PUBLIC / name
    return json.loads(p.read_text()) if p.exists() else None


def _inside(x: float, y: float, ring: list[list[float]]) -> bool:
    hit, j = False, len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            hit = not hit
        j = i
    return hit


def _in_feature(x: float, y: float, f: dict) -> bool:
    """Even-odd over all rings (holes included), with a bounding-box precheck."""
    bb = f.get("_bb")
    if bb and not (bb[0] <= x <= bb[2] and bb[1] <= y <= bb[3]):
        return False
    return sum(_inside(x, y, r) for r in f.get("rings") or []) % 2 == 1


@lru_cache(maxsize=2)
def _features(name: str) -> list[dict]:
    d = _load(name)
    feats = (d or {}).get("features") or []
    for f in feats:
        pts = [p for r in f.get("rings") or [] for p in r]
        if pts:
            f["_bb"] = (min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts))
    return feats


def _point(pid: str) -> tuple[float, float] | None:
    rec = costar.get(str(pid))
    lat, lon = rec.get("latitude"), rec.get("longitude")
    return (lon, lat) if isinstance(lat, (int, float)) and isinstance(lon, (int, float)) else None


def _area(a: dict) -> float:
    return sum(a.get(f"SQFTmain{i}") or 0 for i in range(1, 6))


@lru_cache(maxsize=4096)
def _parcel(pid: str) -> dict | None:
    pt = _point(pid)
    if not pt:
        return None
    hits = [f for f in _features("county_parcels.json") if _in_feature(pt[0], pt[1], f)]
    return max(hits, key=lambda f: (_area(f["a"]), f["a"].get("YearBuilt1") or "")) if hits else None


def assessor(pid: str) -> dict[str, Any] | None:
    f = _parcel(str(pid))
    if not f:
        return None
    a = f["a"]
    year = int(a["YearBuilt1"]) if str(a.get("YearBuilt1") or "").strip().isdigit() and int(a["YearBuilt1"]) > 0 else None
    eff = int(a["EffectiveYear1"]) if str(a.get("EffectiveYear1") or "").strip().isdigit() and int(a["EffectiveYear1"]) > 0 else None
    return {"year_built": year, "effective_year": eff, "sqft": round(_area(a)) or None, "use": a.get("UseDescription") or a.get("UseType"),
            "design_type": a.get("DesignType1"), "units": a.get("Units1") or None, "source": "LA County Assessor parcel (public GIS)"}


@lru_cache(maxsize=4096)
def lariac(pid: str) -> dict[str, Any] | None:
    pt = _point(str(pid))
    if not pt:
        return None
    hits = [f for f in _features("lariac_buildings.json") if _in_feature(pt[0], pt[1], f)]
    if not hits:
        return None
    a = max(hits, key=lambda f: f["a"].get("HEIGHT") or 0)["a"]
    h = a.get("HEIGHT")
    return {"height_ft": round(h, 1) if h else None, "height_m": round(h * FT_TO_M, 1) if h else None,
            "source": "LARIAC building outlines (LA County; 2008 survey imagery, 2020 service)"}


@lru_cache(maxsize=1)
def _business_points() -> list[tuple[float, float, dict]]:
    d = _load("la_businesses.json")
    out = []
    for r in (d or {}).get("rows") or []:
        loc = r.get("location_1") or {}
        try:
            lat, lon = float(loc.get("latitude")), float(loc.get("longitude"))
        except (TypeError, ValueError):
            continue
        if lat and lon:
            out.append((lon, lat, r))
    return out


@lru_cache(maxsize=4096)
def businesses(pid: str) -> dict[str, Any] | None:
    f = _parcel(str(pid))
    if not f or not _business_points():
        return None
    rows = [r for x, y, r in _business_points() if _in_feature(x, y, f)]
    kinds: dict[str, int] = {}
    for r in rows:
        k = (r.get("primary_naics_description") or "unclassified").strip().lower()
        kinds[k] = kinds.get(k, 0) + 1
    top = sorted(kinds.items(), key=lambda kv: -kv[1])[:3]
    return {"active": len(rows), "industries": [{"what": k, "n": n} for k, n in top],
            "source": "LA City active business registrations (public; counts and industries only)"}

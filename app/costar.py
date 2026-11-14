"""CoStar data kit reader (the "costar-hackathon-kit" zip, unzipped OUTSIDE this repo).

The kit is licensed for the event: never copy its files or values into the repo. Point
COSTAR_KIT_DIR at the unzipped folder (default ~/Downloads/costar-hackathon-kit).

Facts from the kit's own docs (index.md, concepts/property-types-and-building-measurement.md):
- 3,339 commercial properties (2,765 multifamily), each with primaryAddress latitude/longitude.
- GBA `grossBuildingAreaSquareFeet` on 3,334 (outside face of walls: same basis as an aerial
  footprint x stories, and as CBECS floorspace). RBA only on 550.
- `numStoriesAboveGrade` (3,327), `buildingHeightInFeet` (361), year built = constructionEvents
  eventType 2, renovations[] with improvement type 8 = Roof, LEED in environmental.leedCertifications.
- Tenancies: location-occupancy (toDate null = current), leaseDeal.expirationDate, spaces[].squareFeetOccupied.
- Enums are integers; decode with schemas/enums.json.
"""

from __future__ import annotations

import csv
import json
import os
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any

FT_TO_M = 0.3048


class CoStarError(RuntimeError):
    pass


def kit_dir() -> Path:
    d = Path(os.environ.get("COSTAR_KIT_DIR", Path.home() / "Downloads" / "costar-hackathon-kit"))
    if not (d / "data" / "commercial-property.jsonl").exists():
        raise CoStarError(f"CoStar kit not found at {d} (set COSTAR_KIT_DIR to the unzipped kit)")
    return d


@lru_cache(maxsize=1)
def _enums() -> dict[str, dict[int, str]]:
    raw = json.loads((kit_dir() / "schemas" / "enums.json").read_text())
    return {name: {int(k): v for k, v in table.items()} for name, table in raw.items() if isinstance(table, dict)}


def _decode(enum: str, value: Any) -> Any:
    return _enums().get(enum, {}).get(value, value) if isinstance(value, int) else value


def _first(*blocks: dict | None, key: str) -> Any:
    for b in blocks:
        if b and b.get(key) is not None:
            return b[key]
    return None


def normalize(r: dict[str, Any], models: list[str] | None = None) -> dict[str, Any]:
    a = r.get("primaryAddress") or {}
    events = {e.get("eventType"): e.get("year") for e in r.get("constructionEvents") or []}
    roof_renos = sorted(x.get("year") for x in r.get("renovations") or [] if 8 in (x.get("renovationImprovementTypes") or []) and x.get("year"))
    blocks = (r.get("propertyOffice"), r.get("propertyIndustrial"), r.get("propertyRetail"), r.get("propertyFlex"))
    leed = [l for l in (r.get("environmental") or {}).get("leedCertifications") or []]
    height_ft = r.get("buildingHeightInFeet")
    return {
        "property_id": str(r["id"]),
        "source": "costar-kit:commercial-property",
        "synthetic": False,
        "property_type": _decode("PropertyType", r.get("propertyType")),
        "property_subtype": _decode("PropertySubtype", r.get("propertySubtype")),
        "address": ", ".join(str(x) for x in (" ".join(str(p) for p in (a.get("streetNumber"), a.get("streetName"), a.get("streetType")) if p),
                                          a.get("city"), a.get("state")) if x),
        "city": a.get("city"),
        "latitude": a.get("latitude"),
        "longitude": a.get("longitude"),
        "gba_sqft": r.get("grossBuildingAreaSquareFeet"),
        "rba_sqft": r.get("rentableBuildingAreaSquareFeet") or _first(*blocks, key="rentableBuildingAreaSquareFeet"),
        "typical_floor_sqft": r.get("grossTypicalFloorSquareFeet"),
        "stories": r.get("numStoriesAboveGrade"),
        "height_m": round(height_ft * FT_TO_M, 2) if isinstance(height_ft, (int, float)) else None,
        "year_built": events.get(2),
        "roof_renovation_years": roof_renos,
        "leed_end_years": [l.get("endYear") for l in leed],
        "owner_occupied": _first(*blocks, key="isOwnerOccupied"),
        "tenancy_type": _decode("TenancyType", (r.get("propertyOffice") or {}).get("tenancyType")),
        "building_class": _decode("BuildingClass", r.get("buildingClass")),
        "matterport_model_ids": models or [],
    }


@lru_cache(maxsize=1)
def _index() -> dict[str, dict[str, Any]]:
    models: dict[str, list[str]] = {}
    with open(kit_dir() / "commercial-properties.csv", newline="") as f:
        for row in csv.DictReader(f):
            if row.get("MatterportModelId"):
                models.setdefault(row["PropertyId"], []).append(row["MatterportModelId"])
    out = {}
    with open(kit_dir() / "data" / "commercial-property.jsonl") as f:
        for line in f:
            r = json.loads(line)
            out[str(r["id"])] = normalize(r, models.get(str(r["id"])))
    return out


def get(property_id: str) -> dict[str, Any]:
    rec = _index().get(str(property_id))
    if rec is None:
        raise CoStarError(f"no CoStar property {property_id} in the kit")
    return dict(rec)


def candidates(types: tuple[str, ...] = ("Office", "Industrial", "GeneralRetail", "Flex", "Hospitality", "Healthcare", "Specialty")) -> list[dict[str, Any]]:
    return [dict(r) for r in _index().values() if r["property_type"] in types and r["latitude"] and r["gba_sqft"]]


@lru_cache(maxsize=1)
def _tenancies() -> dict[str, list[dict[str, Any]]]:
    """Current tenancies per property: occupied sq ft and lease expiration."""
    out: dict[str, list[dict[str, Any]]] = {}
    with open(kit_dir() / "data" / "location-occupancy.jsonl") as f:
        for line in f:
            r = json.loads(line)
            if r.get("toDate"):
                continue
            sqft = sum(s.get("squareFeetOccupied") or 0 for s in r.get("spaces") or [])
            exp = ((r.get("leaseDeal") or {}).get("expirationDate") or "")[:10] or None
            out.setdefault(str(r["propertyId"]), []).append({"sqft": sqft, "expires": exp})
    return out


def lease_profile(property_id: str, horizon_years: int = 10, today: datetime | None = None) -> dict[str, Any]:
    """How much of the occupied space WITH A KNOWN EXPIRATION is leased beyond the solar horizon
    (default 10 years), and how much of the occupied space that covers. Most kit tenancies have no
    expiration on record, so unknown terms are never counted as short."""
    now = today or datetime.now(UTC)
    cutoff = f"{now.year + horizon_years:04d}-{now.month:02d}-{now.day:02d}"
    rows = _tenancies().get(str(property_id), [])
    total = sum(r["sqft"] for r in rows)
    known = [r for r in rows if r["expires"]]
    known_sqft = sum(r["sqft"] for r in known)
    long = sum(r["sqft"] for r in known if r["expires"] >= cutoff)
    return {
        "current_tenancies": len(rows),
        "occupied_sqft": round(total),
        "with_known_expiration": len(known),
        "expiration_known_share": round(known_sqft / total, 2) if total else None,
        "share_leased_beyond_horizon": round(long / known_sqft, 2) if known_sqft else None,
        "horizon_years": horizon_years,
        "latest_expiration": max((r["expires"] for r in known), default=None),
    }

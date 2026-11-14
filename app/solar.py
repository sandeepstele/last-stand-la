"""Solar screening on real data: roof (Vexcel) + building and leases (CoStar) + yield (NREL) +
load (EIA CBECS) + emissions (EPA eGRID). Pure functions; I/O lives in the callers.

Every constant is labeled sourced / heuristic / placeholder and returned with each result.
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

LB_TO_T = 0.000453592
_RESOURCE = json.loads((Path(__file__).parent / "data" / "solar_resource.json").read_text())

SOURCES = {
    "yield": "NREL PVWatts v8, fixed roof mount, standard module, 14% losses, south-facing (app/data/solar_resource.json)",
    "load": "EIA CBECS 2018 Table C22 (released 2022-12-21): conditional electricity intensity, kWh per sq ft of gross floorspace",
    "grid": "EPA eGRID2023 subregion total output CO2 rate: ERCT (Houston) 733.862 lb/MWh, CAMX (Los Angeles) 428.464 lb/MWh",
    "setback": "IFC rooftop PV access pathway: 4 ft perimeter, 6 ft when a roof axis exceeds 250 ft (check the local fire code)",
}

# EIA CBECS 2018 C22, mean kWh/sq ft by principal activity, mapped to CoStar property types.
ELECTRIC_KWH_PER_SQFT: dict[str, tuple[float | None, str]] = {
    "Office": (13.6, "sourced"),
    "Industrial": (5.8, "sourced"),  # CBECS "Warehouse and storage"
    "GeneralRetail": (13.7, "sourced"),  # "Retail (other than mall)"
    "Hospitality": (14.4, "sourced"),  # "Lodging"
    "Healthcare": (23.8, "sourced"),
    "Specialty": (12.6, "sourced"),  # "All buildings"
    "Flex": (9.7, "heuristic"),  # midpoint of office and warehouse
    "Multifamily": (None, "not modeled"),  # tenant-metered; CBECS does not cover residential
}
GRID_T_PER_MWH = {"houston": 733.862 * LB_TO_T, "los_angeles": 428.464 * LB_TO_T}
YIELD_PLACEHOLDER = {"houston": 1350.0, "los_angeles": 1600.0}

ASSUMPTIONS: dict[str, tuple[Any, str]] = {
    "module_w_per_sqft": (20.0, "heuristic"),  # ~430 W module on ~21.5 sq ft
    "gcr_flat": (0.60, "heuristic"),  # ground coverage ratio for low-tilt ballasted rows
    "gcr_pitched": (0.85, "heuristic"),  # flush mount
    "pitched_usable_share": (0.50, "heuristic"),  # south/east/west facets of a pitched roof
    "keepout_sqft": ({"ac-unit": 150, "skylight": 60, "chimney": 40, "satellite-dish": 25, "roof-vent": 10}, "placeholder"),
    "panel_kw": (0.43, "heuristic"),
    "roof_condition_reroof_below": (3.0, "heuristic"),  # Vexcel precise-value, higher is better (inferred scale)
    "roof_condition_ready_from": (4.0, "heuristic"),
    "roof_inspect_age_years": (20, "heuristic"),
    "lease_horizon_years": (10, "heuristic"),
    "footprint_to_floorplate_ok": ((0.3, 3.0), "heuristic"),  # outside this ratio the aerial found another building
}
TILT = {"flat": 10, "pitched": 20}


def _a(key: str) -> Any:
    return ASSUMPTIONS[key][0]


def city_key(city: str | None) -> str | None:
    c = " ".join(str(city or "").lower().replace(",", " ").split())
    if c.startswith("houston"):
        return "houston"
    if c.startswith(("los angeles", "la ")) or c in ("la", "los_angeles"):
        return "los_angeles"
    return None


def yield_kwh_per_kw(city: str, tilt: int) -> tuple[float, str]:
    sourced = (_RESOURCE.get(city) or {}).get(str(tilt))
    if isinstance(sourced, (int, float)):
        return float(sourced), "sourced"
    return YIELD_PLACEHOLDER[city], "placeholder"


@dataclass
class SolarScreen:
    property_id: str
    status: str  # screened | check_link | no_roof_data
    headline: str
    usable_roof_sqft: float = 0.0
    system_kw: float = 0.0
    panels: int = 0
    annual_kwh: float = 0.0
    building_load_kwh: float | None = None
    load_offset_pct: float | None = None
    load_matched_kw: float | None = None  # the array that just covers the building's own annual use
    co2_t_per_year: float = 0.0
    readiness: str = "unknown"  # ready | inspect | reroof_first | unknown
    readiness_reasons: list[str] = field(default_factory=list)
    deal_fit: str = "unknown"  # strong | moderate | weak | unknown
    deal_reasons: list[str] = field(default_factory=list)
    priority: float = 0.0
    roof_breakdown: dict[str, float] = field(default_factory=dict)
    inputs_status: dict[str, str] = field(default_factory=dict)
    sources: dict[str, str] = field(default_factory=lambda: dict(SOURCES))
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _readiness(aerial: dict[str, Any], costar: dict[str, Any], now_year: int) -> tuple[str, list[str]]:
    reasons: list[str] = []
    score = aerial.get("roof_condition_score")
    severe = aerial.get("roof_defects_severe") or []
    last_roof = max([costar.get("year_built") or 0] + list(costar.get("roof_renovation_years") or []))
    age = now_year - last_roof if last_roof else None
    if severe:
        reasons.append(f"Vexcel detects {', '.join(severe)} on the roof")
    if score is not None:
        reasons.append(f"Vexcel roof condition {score:.2f} (higher is better, about 1-5; scale inferred)")
    if age is not None:
        src = "last roof renovation" if costar.get("roof_renovation_years") else "year built (no roof renovation on record)"
        reasons.append(f"roof about {age} years old by {src}")
    if severe or (score is not None and score < _a("roof_condition_reroof_below")):
        return "reroof_first", reasons
    if score is None:
        return "unknown", reasons
    if score < _a("roof_condition_ready_from") or (age is not None and age >= _a("roof_inspect_age_years")):
        return "inspect", reasons
    return "ready", reasons


def _deal_fit(costar: dict[str, Any], lease: dict[str, Any] | None, now_year: int) -> tuple[str, list[str]]:
    reasons, points = [], 0
    if costar.get("owner_occupied") is True:
        points += 2
        reasons.append("owner-occupied: the owner is also the electricity buyer")
    tenancy = str(costar.get("tenancy_type") or "")
    if "Single" in tenancy:
        points += 1
        reasons.append("single-tenant building: one lease to align")
    elif "Multi" in tenancy:
        reasons.append("multi-tenant: needs a landlord-paid or shared-solar structure")
    share = (lease or {}).get("share_leased_beyond_horizon")
    if share is not None:
        reasons.append(f"{share:.0%} of occupied space is leased beyond {lease['horizon_years']} years")
        points += 2 if share >= 0.5 else (1 if share >= 0.2 else 0)
    if any((y or 0) >= now_year for y in costar.get("leed_end_years") or []):
        points += 1
        reasons.append("active LEED certification: a sustainability-minded owner")
    if not reasons:
        return "unknown", ["no ownership or lease data on record"]
    return ("strong" if points >= 3 else "moderate" if points >= 1 else "weak"), reasons


def screen(costar: dict[str, Any], aerial: dict[str, Any] | None, lease: dict[str, Any] | None = None,
           now: datetime | None = None) -> SolarScreen:
    now_year = (now or datetime.now(UTC)).year
    pid = str(costar.get("property_id"))
    city = city_key(costar.get("city"))
    if not aerial or not aerial.get("footprint_sqft") or city is None:
        return SolarScreen(pid, "no_roof_data", "No Vexcel roof data (or unsupported city) for this building.")

    footprint = float(aerial["footprint_sqft"])
    gba, stories = costar.get("gba_sqft"), costar.get("stories") or 1
    lo, hi = _a("footprint_to_floorplate_ok")
    if gba:
        ratio = footprint / (gba / stories)
        if not lo <= ratio <= hi:
            return SolarScreen(pid, "check_link",
                               f"Vexcel's structure ({footprint:,.0f} sq ft) can't be this building's roof "
                               f"(CoStar floor plate about {gba / stories:,.0f} sq ft): the coordinate likely hit another "
                               "structure on the parcel. Not sized.", warnings=[f"footprint / floor plate = {ratio:.2f}"])

    flat = (aerial.get("roof_shape") or "flat") in ("flat", "shed", "mansard")
    shape = "flat" if flat else "pitched"
    roof = footprint * (1.0 if flat else _a("pitched_usable_share"))
    width = 6.0 if (aerial.get("roof_max_dimension_ft") or 0) > 250 else 4.0
    perim = aerial.get("roof_perimeter_ft") or 4 * math.sqrt(footprint)
    setback = max(0.0, perim * width - 4 * width * width) if flat else 0.0
    counted = sum(n * _a("keepout_sqft").get(kind, 0) for kind, n in (aerial.get("roof_objects") or {}).items())
    keepout = max(counted, aerial.get("roof_object_area_sqft") or 0.0)
    existing = aerial.get("existing_pv_sqft") or 0.0
    shade = min(1.0, (aerial.get("roof_tree_cover_pct") or 0.0) / 100)
    usable = max(0.0, roof - setback - keepout - existing) * (1 - shade)

    gcr = _a("gcr_flat") if flat else _a("gcr_pitched")
    kw = usable * gcr * _a("module_w_per_sqft") / 1000
    per_kw, yield_status = yield_kwh_per_kw(city, TILT[shape])
    kwh = kw * per_kw
    intensity, load_status = ELECTRIC_KWH_PER_SQFT.get(costar.get("property_type"), (None, "not modeled"))
    load = gba * intensity if (gba and intensity) else None
    co2 = kwh / 1000 * GRID_T_PER_MWH[city]

    readiness, r_reasons = _readiness(aerial, costar, now_year)
    deal, d_reasons = _deal_fit(costar, lease, now_year)
    priority = kwh * {"ready": 1.0, "inspect": 0.8, "reroof_first": 0.6, "unknown": 0.7}[readiness] * \
        {"strong": 1.0, "moderate": 0.85, "weak": 0.6, "unknown": 0.7}[deal]

    seq = {"ready": "Roof can take solar now.", "inspect": "Inspect the roof before committing.",
           "reroof_first": "Re-roof first, then solar.", "unknown": "Roof condition not graded."}[readiness]
    load_kw = load / per_kw if load else None  # array that just covers the building's own annual use
    if load and kwh > load:
        offset = (f"; the full roof makes {kwh / load:.1f}x the building's estimated use, so a {load_kw:,.0f} kW array "
                  "covers the building and the rest is export or community solar")
    else:
        offset = f", {kwh / load:.0%} of the building's estimated load" if load else ""
    headline = (f"{kw:,.0f} kW on {usable:,.0f} sq ft of usable roof: about {kwh / 1000:,.0f} MWh/yr{offset}, "
                f"{co2:,.0f} t CO2/yr avoided. {seq} Deal fit: {deal}.")
    warnings = list(aerial.get("warnings") or [])
    if yield_status != "sourced":
        warnings.append(f"solar yield for {city} is a placeholder until PVWatts is refreshed")
    return SolarScreen(
        pid, "screened", headline,
        usable_roof_sqft=round(usable), system_kw=round(kw, 1), panels=int(kw // _a("panel_kw")),
        annual_kwh=round(kwh), building_load_kwh=round(load) if load else None,
        load_offset_pct=round(kwh / load * 100, 1) if load else None, co2_t_per_year=round(co2, 1),
        load_matched_kw=round(min(kw, load_kw), 1) if load_kw else None,
        readiness=readiness, readiness_reasons=r_reasons, deal_fit=deal, deal_reasons=d_reasons,
        priority=round(priority),
        roof_breakdown={"roof_sqft": round(roof), "fire_setback_sqft": round(setback), "equipment_keepout_sqft": round(keepout),
                        "existing_pv_sqft": round(existing), "tree_shade_pct": round(shade * 100, 1), "setback_ft": width},
        inputs_status={"yield": yield_status, "load": load_status, "grid": "sourced",
                       **{k: v[1] for k, v in ASSUMPTIONS.items()}},
        warnings=warnings,
    )

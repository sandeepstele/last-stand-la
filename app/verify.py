"""The verifier: plain Python. LLMs gather and explain; this does the arithmetic.

Every constant lives in ASSUMPTIONS and is returned with each result, labeled
"placeholder" (must be sourced before the demo), "heuristic" (a design choice we show
on screen) or "sourced" (add the citation to SOURCED when a teammate looks it up).

Rules that keep verdicts honest (see docs/ENGINEERING.md, "Verifier rules"):
- A twin rules things out only if it covers most of the footprint (coverage_complete_share).
- Basement area is capped at the scanned extent of that level, never assumed to be a full footprint.
- Mezzanines are counted once per level and never as floors.
- Height implies a RANGE of floor counts (floor-height tolerance plus parapet), never round().
- A phone ceiling height only caps the floor count (app/field.py).
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Any

from app.field import FieldScan, max_floors
from app.interior import SQFT_PER_M2, InteriorProfile

ASSUMPTIONS: dict[str, Any] = {
    "efficiency_band": (0.80, 1.00),  # listed rentable area vs footprint x stories (gross)
    "gross_band": (0.90, 1.10),  # listed GROSS area (CoStar GBA, outside face of walls) vs footprint x stories
    "stories_convention": "above-grade",  # listed stories count floors from the entrance up: VERIFY with CoStar
    "coverage_complete_share": 0.70,  # a twin must span this share of the footprint to rule anything out
    "mezzanine_share": 0.5,
    "default_floor_to_floor_m": {"office": 4.0, "retail": 4.5, "industrial": 9.0, "multifamily": 3.1},
    "floor_height_tolerance": 0.10,  # +/- on floor-to-floor when turning height into floors
    "parapet_allowance_m": 1.0,  # roof edge / mechanical above the top floor
    "roof_setback_ft": 4.0,  # fire-access perimeter; check local code
    "pv_density_w_per_sqft": 12.0,  # flat commercial roof incl. row spacing
    "panel_kw": 0.43,
    "yield_kwh_per_kw": {"houston": 1350, "los_angeles": 1600},  # replace with PVWatts runs
    "electric_kwh_per_sqft": {"office": 15.0, "retail": 14.0, "industrial": 6.0, "multifamily": 9.0},  # CBECS
    "grid_t_co2_per_mwh": {"houston": 0.37, "los_angeles": 0.22},  # EPA eGRID subregions
    "reroof_conditions": ("poor", "fair"),
}
_HEURISTIC = {"efficiency_band", "gross_band", "coverage_complete_share", "floor_height_tolerance", "reroof_conditions", "stories_convention"}
SOURCED: dict[str, str] = {}  # e.g. {"yield_kwh_per_kw": "NREL PVWatts v8, run 2026-11-14"}


def assumption_status(keys: list[str] | None = None) -> dict[str, dict[str, Any]]:
    out = {}
    for key in keys or list(ASSUMPTIONS):
        status = "sourced" if key in SOURCED else ("heuristic" if key in _HEURISTIC else "placeholder")
        out[key] = {"value": ASSUMPTIONS[key], "status": status, "source": SOURCED.get(key)}
    return out


def placeholders(keys: list[str]) -> list[str]:
    return [k for k, v in assumption_status(keys).items() if v["status"] == "placeholder"]


# ---------------------------------------------------------------- inputs


@dataclass
class Records:
    """What the CoStar record claims. `rba_sqft` is the listed area; `area_basis` says which kind:
    "rentable" (RBA, compared with efficiency_band) or "gross" (GBA, compared with gross_band)."""

    rba_sqft: float
    stories: int
    building_type: str = "office"
    land_area_sqft: float | None = None
    building_count: int | None = None
    year_renovated: int | None = None
    area_basis: str = "rentable"

    @property
    def band(self) -> tuple[float, float]:
        return ASSUMPTIONS["gross_band" if self.area_basis == "gross" else "efficiency_band"]


@dataclass
class Aerial:
    """What Vexcel measured."""

    footprint_sqft: float
    height_m: float | None = None
    roof_condition: str | None = None
    roof_object_area_sqft: float = 0.0
    setback_detected: bool | None = None
    perimeter_ft: float | None = None


# ---------------------------------------------------------------- reconciliation


@dataclass
class Reconciliation:
    listed_sqft: float
    gross_sqft: float
    expected_low_sqft: float
    expected_high_sqft: float
    status: str  # within | above | below
    gap_pct: float  # signed, vs. the nearest edge of the band; 0 when within
    formula: str


def reconcile_area(
    listed_sqft: float,
    footprint_sqft: float,
    stories: int,
    extra_gross_sqft: float = 0.0,
    band: tuple[float, float] | None = None,
) -> Reconciliation:
    lo_f, hi_f = band or ASSUMPTIONS["efficiency_band"]
    gross = footprint_sqft * stories + extra_gross_sqft
    lo, hi = gross * lo_f, gross * hi_f
    if listed_sqft > hi:
        status, gap = "above", (listed_sqft - hi) / hi * 100
    elif listed_sqft < lo:
        status, gap = "below", (listed_sqft - lo) / lo * 100
    else:
        status, gap = "within", 0.0
    extra = f" {'+' if extra_gross_sqft >= 0 else '-'} {abs(extra_gross_sqft):,.0f}" if extra_gross_sqft else ""
    formula = (
        f"({footprint_sqft:,.0f} footprint x {stories} stories{extra}) x {lo_f:.2f}-{hi_f:.2f}"
        f" = {lo:,.0f}-{hi:,.0f} sq ft expected; listed {listed_sqft:,.0f}"
    )
    return Reconciliation(listed_sqft, round(gross), round(lo), round(hi), status, round(gap, 1), formula)


# ---------------------------------------------------------------- investigation


@dataclass
class Hypothesis:
    key: str
    title: str
    explains: str  # above | below | either
    tester: str  # interior | aerial | records | field (combinations joined with +)
    status: str  # supported | ruled_out | untested
    evidence: str
    strength: str = "medium"  # high | medium | low (only high/medium adjustments are applied)
    extra_gross_sqft: float | None = None  # quantified adjustment, if any


@dataclass
class Investigation:
    initial: Reconciliation
    hypotheses: list[Hypothesis]
    applied: list[str]
    final: Reconciliation
    verdict: str  # consistent | verified_inside_and_out | explained | likely_explained | worth_a_look
    confidence: str  # high | medium | low
    headline: str
    twin_coverage: float | None = None
    trusted_area_sqft: float | None = None  # listed area when the verdict explains it; None otherwise
    assumptions: dict[str, Any] = field(default_factory=assumption_status)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _complete(interior: InteriorProfile, aerial: Aerial) -> bool:
    return interior.coverage(aerial.footprint_sqft) >= ASSUMPTIONS["coverage_complete_share"]


def _coverage_note(interior: InteriorProfile, aerial: Aerial) -> str:
    return f"twin spans about {interior.coverage(aerial.footprint_sqft):.0%} of the footprint"


def _below_grade(records: Records, aerial: Aerial, interior: InteriorProfile | None, field_scan: FieldScan | None) -> Hypothesis:
    h = Hypothesis("below_grade", "Below-grade levels (basement, garage)", "above", "interior", "untested", "No twin for this building.")
    if interior is not None:
        below = interior.levels_below_entrance
        if below:
            extra = sum(min(aerial.footprint_sqft, lv.extent_m2 * SQFT_PER_M2) for lv in below)
            h.status, h.extra_gross_sqft = "supported", round(extra)
            h.strength = "medium" if interior.entrance_ambiguous else "high"
            h.evidence = (
                f"Twin has {len(below)} level(s) below the entrance ("
                + ", ".join(f"{lv.label} at {lv.median_z_m:+.1f} m" for lv in below)
                + f"), scanned over at least {extra:,.0f} sq ft."
            )
        elif _complete(interior, aerial) and interior.full_levels_from_entrance >= records.stories:
            h.status = "ruled_out"
            h.evidence = (
                f"The {_coverage_note(interior, aerial)} on all {interior.full_levels_from_entrance} floors "
                "from the entrance up, and nothing is below it."
            )
        else:
            h.evidence = f"Nothing below the entrance in the twin, but the {_coverage_note(interior, aerial)}; a basement may not be scanned."
    if field_scan is None or h.status == "supported":
        return h
    if field_scan.levels_below:
        h.status, h.tester, h.strength = "supported", "field", "medium"
        h.extra_gross_sqft = round(min(aerial.footprint_sqft, field_scan.net_area_sqft or aerial.footprint_sqft))
        h.evidence = (
            f"Field scan (one session, starting at the entrance) found a level at {field_scan.levels_below[0]:+.1f} m "
            f"(about ±0.15 m, inferred); counted at its scanned area, {h.extra_gross_sqft:,.0f} sq ft at most."
        )
    elif field_scan.searched_below and h.status == "untested":
        h.status, h.tester = "ruled_out", "field"
        h.evidence = "Field check: the operator looked for stairs going down and found no lower level."
    return h


def _mezzanine(records: Records, aerial: Aerial, interior: InteriorProfile | None, field_scan: FieldScan | None) -> Hypothesis:
    h = Hypothesis("mezzanine", "Mezzanine or partial floors", "above", "interior", "untested", "No twin for this building.")
    if interior is None:
        return h
    if interior.mezzanine_levels:
        n = len(interior.mezzanine_levels)
        h.status, h.strength = "supported", "medium"
        h.extra_gross_sqft = round(n * aerial.footprint_sqft * ASSUMPTIONS["mezzanine_share"])
        h.evidence = f"{n} mezzanine level(s) in the twin: {', '.join(interior.mezzanine_levels)}."
    elif _complete(interior, aerial) and interior.full_levels_from_entrance >= records.stories:
        h.status = "ruled_out"
        h.evidence = f"The {_coverage_note(interior, aerial)} and every level is a full floor-to-floor apart."
    else:
        h.evidence = f"No mezzanine in the twin, but the {_coverage_note(interior, aerial)}."
    return h


def _floor_count(records: Records, aerial: Aerial, interior: InteriorProfile | None, field_scan: FieldScan | None) -> Hypothesis:
    h = Hypothesis("floor_count", "More or fewer floors than listed", "either", "interior+aerial", "untested", "No measured height.")
    if interior is not None and interior.full_levels_from_entrance > records.stories:
        n = interior.full_levels_from_entrance
        h.status, h.strength, h.explains = "supported", "high", "above"
        h.extra_gross_sqft = (n - records.stories) * aerial.footprint_sqft
        h.evidence = f"Twin shows {n} full floors from the entrance up; the record lists {records.stories}."
        return h
    # A field scan's ceiling height is a BOUND (floor-to-floor > clear height): it can rule out
    # "more floors than listed" but never adds floors.
    cap = max_floors(aerial.height_m, field_scan)
    if cap is not None and cap <= records.stories:
        h.status, h.tester, h.explains = "ruled_out", "field+aerial", "above"
        h.evidence = (
            f"At most {cap} floor(s) fit in {aerial.height_m:.1f} m at the measured "
            f"{field_scan.ceiling_height_m:.2f} m ceiling (field scan), so there are no more floors than the "
            f"{records.stories} listed."
        )
        if cap < records.stories:
            h.evidence += " The listed count does not fit either: check that the scanned room is a typical floor."
        return h
    if aerial.height_m is None:
        return h
    twin_ftf = interior.typical_floor_to_floor_m if interior is not None else None
    ftf = twin_ftf or ASSUMPTIONS["default_floor_to_floor_m"].get(records.building_type, 4.0)
    source = "twin" if twin_ftf else "default"
    tol, parapet = ASSUMPTIONS["floor_height_tolerance"], ASSUMPTIONS["parapet_allowance_m"]
    n_hi = max(1, math.floor(aerial.height_m / (ftf * (1 - tol))))
    n_lo = max(1, math.floor((aerial.height_m - parapet) / (ftf * (1 + tol))))
    span = f"{aerial.height_m:.1f} m at {ftf:.2f} m per floor ({source}) fits {n_lo}-{n_hi} floors"
    if records.stories > n_hi:
        h.status, h.explains = "supported", "below"
        h.strength = "medium" if source == "twin" else "low"
        h.extra_gross_sqft = (n_hi - records.stories) * aerial.footprint_sqft
        h.evidence = f"{span}; the record lists {records.stories}."
    elif records.stories < n_lo:
        h.status, h.explains = "supported", "above"
        h.strength = "medium" if source == "twin" else "low"
        h.extra_gross_sqft = (n_lo - records.stories) * aerial.footprint_sqft
        h.evidence = f"{span}; the record lists {records.stories}."
    else:
        h.status = "ruled_out"
        h.evidence = f"{span}, consistent with the {records.stories} listed."
    return h


def _setback(records: Records, aerial: Aerial, interior: InteriorProfile | None, field_scan: FieldScan | None) -> Hypothesis:
    h = Hypothesis("setback", "Setback tower or podium", "below", "aerial", "untested", "No setback data yet.")
    if aerial.setback_detected is True:
        h.status, h.evidence = "supported", "Aerial data shows upper floors smaller than the footprint."
    elif aerial.setback_detected is False:
        h.status, h.evidence = "ruled_out", "Aerial data shows a straight extrusion."
    return h


def _merged_footprint(records: Records, aerial: Aerial, interior: InteriorProfile | None, field_scan: FieldScan | None) -> Hypothesis:
    h = Hypothesis("merged_footprint", "Footprint merges a neighbor or several buildings", "below", "aerial+records", "untested", "")
    if records.land_area_sqft and aerial.footprint_sqft > records.land_area_sqft * 1.02:
        h.status = "supported"
        h.evidence = f"Footprint {aerial.footprint_sqft:,.0f} sq ft exceeds land area {records.land_area_sqft:,.0f} sq ft."
    elif records.building_count and records.building_count > 1:
        h.status = "supported"
        h.evidence = f"The record lists {records.building_count} buildings on the parcel."
    elif records.building_count == 1 and records.land_area_sqft:
        h.status = "ruled_out"
        h.evidence = "One building on the parcel, and the footprint fits the land area."
    elif records.building_count == 1:
        h.status = "ruled_out"
        h.evidence = "The record lists one building on the parcel (land area unknown)."
    else:
        h.evidence = "Building count and land area unknown."
    return h


def _stale_record(records: Records, aerial: Aerial, interior: InteriorProfile | None, field_scan: FieldScan | None) -> Hypothesis:
    return Hypothesis(
        "stale_record", "Addition or demolition since the record", "either", "records+aerial", "untested",
        "Needs two aerial captures to compare; not available this weekend.",
    )


_TESTS = (_below_grade, _mezzanine, _floor_count, _setback, _merged_footprint, _stale_record)


def twin_fits_height(interior: InteriorProfile, aerial: Aerial) -> bool:
    """Cross-layer sanity check: the twin's levels from the entrance up must fit inside the
    aerial height (with tolerance and parapet). If not, the twin is probably not this building."""
    span = interior.height_from_entrance_m
    if span is None or aerial.height_m is None:
        return True
    return span <= aerial.height_m * (1 + ASSUMPTIONS["floor_height_tolerance"]) + ASSUMPTIONS["parapet_allowance_m"]
_VERDICT_KEYS = ["efficiency_band", "gross_band", "coverage_complete_share", "mezzanine_share", "default_floor_to_floor_m",
                 "floor_height_tolerance", "parapet_allowance_m", "stories_convention"]


def investigate(
    records: Records,
    aerial: Aerial,
    interior: InteriorProfile | None = None,
    field_scan: FieldScan | None = None,
) -> Investigation:
    """`field_scan` is an iPhone field check for THIS building. Stand-in scans are ignored here
    (they are previews), so a room scanned elsewhere can never change a verdict."""
    initial = reconcile_area(records.rba_sqft, aerial.footprint_sqft, records.stories, band=records.band)
    live_field = field_scan if field_scan is not None and not field_scan.stand_in else None
    warnings: list[str] = []
    if interior is not None and not twin_fits_height(interior, aerial):
        warnings.append(
            f"The twin's levels span {interior.height_from_entrance_m:.1f} m from the entrance up, more than the "
            f"{aerial.height_m:.1f} m aerial height: the linked twin may not be this building, so it was ignored."
        )
        interior = None
    hyps = [t(records, aerial, interior, live_field) for t in _TESTS]
    coverage = round(interior.coverage(aerial.footprint_sqft), 2) if interior is not None else None
    status = assumption_status(_VERDICT_KEYS)

    def result(final, applied, verdict, confidence, headline, trusted):
        return Investigation(initial, hyps, applied, final, verdict, confidence, headline, coverage, trusted, status, warnings)

    if initial.status == "within":
        return result(initial, [], "consistent", "high", f"Record and measurements agree: {initial.formula}.", records.rba_sqft)

    direction = initial.status
    final, applied, extra = initial, [], 0.0
    for h in hyps:
        if (
            h.status == "supported"
            and h.extra_gross_sqft
            and h.strength in ("high", "medium")
            and h.explains in (direction, "either")
            and (h.extra_gross_sqft > 0) == (direction == "above")
        ):
            extra += h.extra_gross_sqft
            applied.append(h.key)
            final = reconcile_area(records.rba_sqft, aerial.footprint_sqft, records.stories, extra, band=records.band)
            if final.status == "within":
                break

    gap = f"Listed {records.rba_sqft:,.0f} sq ft vs. {initial.expected_low_sqft:,.0f}-{initial.expected_high_sqft:,.0f} expected ({initial.gap_pct:+.1f}%)."
    if final.status == "within":
        used = [h for h in hyps if h.key in applied]
        inside = any("interior" in h.tester or "field" in h.tester for h in used)
        confidence = "high" if all(h.strength == "high" for h in used) else "medium"
        label = "Verified inside and out." if inside else "Explained."
        return result(final, applied, "verified_inside_and_out" if inside else "explained", confidence,
                      f"{gap} {' '.join(h.evidence for h in used)} {label}", records.rba_sqft)

    unquantified = [h for h in hyps if h.status == "supported" and h.extra_gross_sqft is None and h.explains in (direction, "either")]
    if unquantified:
        return result(final, applied, "likely_explained", "medium",
                      f"{gap} Likely: {unquantified[0].evidence} Confirm before acting.", None)

    relevant = [h for h in hyps if h.explains in (direction, "either")]
    untested = sum(h.status == "untested" for h in relevant)
    confidence = "high" if untested == 0 else "medium" if untested <= len(relevant) / 2 else "low"
    ruled = [h.title for h in relevant if h.status == "ruled_out"]
    return result(final, applied, "worth_a_look", confidence,
                  f"{gap} Ruled out: {', '.join(ruled) or 'nothing yet'}. Worth a look.", None)


# ---------------------------------------------------------------- retrofit

CITIES = {"houston": "houston", "houston tx": "houston", "los angeles": "los_angeles", "los_angeles": "los_angeles",
          "la": "los_angeles", "los angeles ca": "los_angeles"}


def normalize_city(city: str) -> str:
    key = " ".join(str(city).lower().replace(",", " ").split())
    if key not in CITIES:
        raise ValueError(f"unsupported city {city!r}: use houston or los_angeles")
    return CITIES[key]


@dataclass
class Retrofit:
    usable_roof_sqft: float
    system_kw: float
    panels: int
    annual_kwh: float
    building_load_kwh: float
    load_offset_pct: float
    co2_t_per_year: float
    reroof_first: bool
    sequence: str
    assumptions: dict[str, Any]
    placeholders: list[str]


def retrofit_math(records: Records, aerial: Aerial, trusted_area_sqft: float, city: str) -> Retrofit:
    a, c = ASSUMPTIONS, normalize_city(city)
    fp = aerial.footprint_sqft
    perim = aerial.perimeter_ft or 4 * math.sqrt(fp)
    s = a["roof_setback_ft"]
    setback_area = max(0.0, perim * s - 4 * s * s)
    usable = max(0.0, fp - aerial.roof_object_area_sqft - setback_area)
    kw = usable * a["pv_density_w_per_sqft"] / 1000
    kwh = kw * a["yield_kwh_per_kw"][c]
    intensity = a["electric_kwh_per_sqft"].get(records.building_type, a["electric_kwh_per_sqft"]["office"])
    load = trusted_area_sqft * intensity
    reroof = (aerial.roof_condition or "").lower() in a["reroof_conditions"]
    keys = ["roof_setback_ft", "pv_density_w_per_sqft", "panel_kw", "yield_kwh_per_kw", "electric_kwh_per_sqft", "grid_t_co2_per_mwh"]
    used = {k: v["value"] for k, v in assumption_status(keys).items()}
    used.update(yield_kwh_per_kw=a["yield_kwh_per_kw"][c], electric_kwh_per_sqft=intensity, grid_t_co2_per_mwh=a["grid_t_co2_per_mwh"][c])
    return Retrofit(
        usable_roof_sqft=round(usable),
        system_kw=round(kw, 1),
        panels=int(kw // a["panel_kw"]),
        annual_kwh=round(kwh),
        building_load_kwh=round(load),
        load_offset_pct=round(kwh / load * 100, 1) if load else 0.0,
        co2_t_per_year=round(kwh / 1000 * a["grid_t_co2_per_mwh"][c], 1),
        reroof_first=reroof,
        sequence="Re-roof first, then solar." if reroof else "Roof can take solar now.",
        assumptions=used,
        placeholders=placeholders(keys),
    )

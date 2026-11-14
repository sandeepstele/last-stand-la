"""Data layers: CoStar records, Vexcel aerial attributes, Matterport twin.

Every loader returns data WITH provenance (`source`, `synthetic`), and the verifier loads
numbers here by property id, never from numbers an LLM typed into a tool call.

Modes (env), default auto:
  RADAR_LAYER_COSTAR  cached = fixtures/costar/<id>.json only (the synthetic TEST-* records)
                      kit    = the CoStar data kit (app/costar.py; COSTAR_KIT_DIR, outside the repo). "live" = kit
                      auto   = the fixture if there is one, else the kit
  RADAR_LAYER_VEXCEL  cached = fixtures/vexcel/<id>.json only
                      live   = Vexcel property/extract at the CoStar coordinates (VEXCEL_API_KEY), then cached
                      auto   = the cache if there is one, else live
  RADAR_MATTERPORT    auto | live | cached (app/matterport.py; team token)
Everything here blocks (files, HTTP): call it through asyncio.to_thread from async code.

Licensing: real CoStar / Vexcel / Matterport data must not reach the public repo.
.gitignore ignores fixtures/*/* except the synthetic TEST-* files; the kit stays outside the repo.
"""

from __future__ import annotations

import json
import math
import os
import re
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app import costar, interior, matterport, solar, vexcel
from app.verify import Aerial, Records

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"
PROPERTY_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_MODES = {"costar": ("cached", "kit", "auto"), "vexcel": ("cached", "live", "auto")}
_CACHED_ONLY: ContextVar[bool] = ContextVar("layers_cached_only", default=False)


@contextmanager
def cached_only():
    """Make layer reads use local fixtures only in the current context."""
    token = _CACHED_ONLY.set(True)
    try:
        yield
    finally:
        _CACHED_ONLY.reset(token)

# CoStar property type -> the verifier's building_type (default floor-to-floor heights)
VERIFIER_TYPE = {"Office": "office", "Industrial": "industrial", "Flex": "industrial", "GeneralRetail": "retail",
                 "Multifamily": "multifamily"}
# the synthetic fixtures' building_type -> CoStar property type (CBECS load intensity)
SOLAR_TYPE = {"office": "Office", "industrial": "Industrial", "warehouse": "Industrial", "retail": "GeneralRetail",
              "multifamily": "Multifamily"}
_OBJECT_KIND = {"ac unit": "ac-unit", "hvac unit": "ac-unit", "skylight": "skylight", "chimney": "chimney",
                "satellite dish": "satellite-dish", "roof vent": "roof-vent"}


class LayerError(RuntimeError):
    pass


def check_property_id(property_id: str) -> str:
    pid = str(property_id).strip()
    if not PROPERTY_ID.match(pid):
        raise LayerError(f"invalid property id: {property_id!r}")
    return pid


def _mode(layer: str) -> str:
    if _CACHED_ONLY.get() and layer in ("costar", "vexcel"):
        return "cached"
    mode = os.environ.get(f"RADAR_LAYER_{layer.upper()}", "auto").strip().lower()
    if layer == "costar" and mode == "live":
        mode = "kit"
    if mode not in _MODES[layer]:
        raise LayerError(f"RADAR_LAYER_{layer.upper()} must be one of {', '.join(_MODES[layer])}")
    return mode


def _path(layer: str, pid: str) -> Path:
    return FIXTURES / layer / f"{pid}.json"


def _fixture(layer: str, property_id: str) -> dict[str, Any]:
    pid = check_property_id(property_id)
    path = _path(layer, pid)
    if not path.exists():
        raise LayerError(f"no cached {layer} data for {pid}")
    data = json.loads(path.read_text())
    data["synthetic"] = bool(data.get("synthetic", False))
    data.setdefault("source", f"cache:{layer}/{pid}.json")
    return data


def get_record(property_id: str) -> dict[str, Any]:
    pid = check_property_id(property_id)
    mode = _mode("costar")
    if mode == "cached" or (mode == "auto" and _path("costar", pid).exists()):
        return _fixture("costar", pid)
    try:
        rec = costar.get(pid)
    except costar.CoStarError as e:
        raise LayerError(str(e)) from e
    models = rec.get("matterport_model_ids") or []
    rec["matterport_model_id"] = models[0] if models else None  # get_twin picks the best linked twin
    rec["building_type"] = VERIFIER_TYPE.get(rec.get("property_type"), str(rec.get("property_type") or "office").lower())
    return rec


def get_aerial(property_id: str, record: dict[str, Any] | None = None) -> dict[str, Any]:
    """Vexcel at the CoStar record's own coordinates. A live fetch is cached (gitignored)."""
    pid = check_property_id(property_id)
    mode = _mode("vexcel")
    path = _path("vexcel", pid)
    if mode == "cached" or (mode == "auto" and path.exists()):
        return _fixture("vexcel", pid)
    rec = record if record is not None else get_record(pid)
    lat, lon = rec.get("latitude"), rec.get("longitude")
    if rec.get("synthetic") or not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        raise LayerError(f"{pid} has no real coordinates on its CoStar record, so Vexcel can't be queried")
    try:
        data = vexcel.normalize(vexcel.property_extract(lat, lon), pid, lat, lon)
    except vexcel.VexcelError as e:
        raise LayerError(f"Vexcel: {e}") from e
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data))
    tmp.replace(path)
    data["synthetic"] = False
    return data


TWIN_MAX_DISTANCE_M = 250  # heuristic: a linked twin geolocated farther than this from the CoStar point is ignored


def _distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6_371_000 * math.asin(math.sqrt(a))


MAX_TWINS = 10  # the kit links up to 10 twins (suites, lobbies, floors) to one property


def _twin_distance_m(rec: dict[str, Any], layout: dict[str, Any]) -> float | None:
    geo = layout.get("geolocation") or {}
    try:
        return _distance_m(float(rec["latitude"]), float(rec["longitude"]), float(geo["lat"]), float(geo["long"]))
    except (KeyError, TypeError, ValueError):
        return None  # no geolocation on one side (e.g. the synthetic TEST-A record): no distance check


def _scanned_sqft(layout: dict[str, Any]) -> float:
    """Matterport's measured area of the twin's largest floor (its best shot at covering the footprint)."""
    floors = [(f.get("dimensions") or {}).get("areaFloor") or 0 for f in layout.get("floors") or []]
    return float(max(floors, default=0) or (layout.get("dimensions") or {}).get("areaFloor") or 0)


def get_twin(property_id: str, record: dict[str, Any] | None = None) -> tuple[str | None, interior.InteriorProfile | None]:
    """The best Matterport twin the CoStar record links to this property: among linked twins
    geolocated within TWIN_MAX_DISTANCE_M of the CoStar point, the one with the largest scanned floor.
    Raises LayerError when every linked twin is far away or unreadable."""
    rec = record if record is not None else get_record(property_id)
    ids = list(rec.get("matterport_model_ids") or ([rec["matterport_model_id"]] if rec.get("matterport_model_id") else []))
    if not ids:
        return None, None
    best: tuple[float, str, dict[str, Any]] | None = None
    refused: list[str] = []
    for model_id in ids[:MAX_TWINS]:
        try:
            layout = matterport.fetch_layout(model_id)
        except matterport.MatterportError as e:
            refused.append(f"{model_id}: {e}")
            continue
        d = _twin_distance_m(rec, layout)
        if d is not None and d > TWIN_MAX_DISTANCE_M:
            refused.append(f"the linked twin '{layout.get('name')}' is geolocated {d:,.0f} m from the CoStar point, "
                           "so it is probably not this building")
            continue
        area = _scanned_sqft(layout)
        if best is None or area > best[0]:
            best = (area, model_id, layout)
    if best is None:
        raise LayerError("; ".join(refused))
    rec["matterport_model_id"] = best[1]
    return best[1], interior.profile(best[2])


@dataclass
class Building:
    property_id: str
    records: Records
    aerial: Aerial
    twin_id: str | None
    twin: interior.InteriorProfile | None
    record_raw: dict[str, Any]
    aerial_raw: dict[str, Any]
    provenance: dict[str, dict[str, Any]] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    link_problem: str | None = None  # set when Vexcel's structure can't be this building

    @property
    def synthetic(self) -> bool:
        return any(p.get("synthetic") for p in self.provenance.values())


def _positive(raw: dict[str, Any], key: str, layer: str) -> float:
    value = raw.get(key)
    if not isinstance(value, (int, float)) or value <= 0:
        raise LayerError(f"{layer} data has no usable {key}")
    return float(value)


def _listed_area(rec: dict[str, Any]) -> tuple[float, str]:
    """CoStar GBA when the record has it (same basis as footprint x stories), else RBA."""
    gba = rec.get("gba_sqft")
    if isinstance(gba, (int, float)) and gba > 0:
        return float(gba), "gross"
    return _positive(rec, "rba_sqft", "CoStar"), "rentable"


def _link_problem(footprint: float, listed: float, basis: str, stories: int) -> str | None:
    """A footprint far from the CoStar floor plate means the point hit another structure on the parcel."""
    if basis != "gross":
        return None
    plate = listed / stories
    lo, hi = solar.ASSUMPTIONS["footprint_to_floorplate_ok"][0]
    ratio = footprint / plate
    if lo <= ratio <= hi:
        return None
    return (f"Vexcel's structure at the CoStar point is {footprint:,.0f} sq ft against a CoStar floor plate of about "
            f"{plate:,.0f} sq ft ({ratio:.2f}x): it is probably another structure on the parcel, not this building.")


PARCEL_SLACK = 1.25  # roof overhangs and parcel mapping error explain up to ~25%; 52227 is 1.44x


def _outline_problem(aer: dict) -> str | None:
    """An outline bigger than its own parcel almost always includes a neighbor (shared party walls downtown)."""
    fp, parcel = aer.get("footprint_sqft"), aer.get("parcel_area_sqft")
    if not fp or not parcel or fp <= PARCEL_SLACK * parcel:
        return None
    return (f"Vexcel's outline is {fp:,.0f} sq ft but its parcel is only {parcel:,.0f} sq ft: the outline likely includes a "
            "neighboring building that shares a wall, so it can't measure this building on its own.")


def load_building(property_id: str) -> Building:
    """Everything the verifier needs, validated. Raises LayerError with a readable message."""
    pid = check_property_id(property_id)
    rec = get_record(pid)
    aer = get_aerial(pid, rec)
    listed, basis = _listed_area(rec)
    records = Records(
        rba_sqft=listed,
        area_basis=basis,
        stories=int(_positive(rec, "stories", "CoStar")),
        building_type=str(rec.get("building_type") or "office"),
        land_area_sqft=rec.get("land_area_sqft"),
        building_count=rec.get("building_count"),
        year_renovated=rec.get("year_renovated"),
    )
    aerial = Aerial(
        footprint_sqft=_positive(aer, "footprint_sqft", "Vexcel"),
        height_m=aer.get("height_m"),
        roof_condition=aer.get("roof_condition"),
        roof_object_area_sqft=float(aer.get("roof_object_area_sqft") or 0.0),
        setback_detected=aer.get("setback_detected"),
        perimeter_ft=aer.get("perimeter_ft") or aer.get("roof_perimeter_ft"),
    )
    warnings: list[str] = list(aer.get("warnings") or [])
    try:
        twin_id, twin = get_twin(pid, rec)
    except (matterport.MatterportError, LayerError) as e:
        twin_id, twin = rec.get("matterport_model_id"), None
        warnings.append(f"twin unavailable: {e}")
    provenance = {
        "costar": {"source": rec["source"], "synthetic": rec["synthetic"], "area_basis": basis},
        "vexcel": {"source": aer["source"], "synthetic": aer["synthetic"], "capture_date": aer.get("capture_date"),
                   "structure_chosen_by": aer.get("structure_chosen_by")},
    }
    if twin_id:
        provenance["matterport"] = {
            "source": f"matterport:{twin_id}",
            "twin_loaded": twin is not None,  # the verifier may still ignore it (see warnings)
            "synthetic": False,
            "linked_by": "costar record (synthetic link)" if rec["synthetic"] else "costar record",
        }
    link = _link_problem(aerial.footprint_sqft, listed, basis, records.stories) or _outline_problem(aer)
    return Building(pid, records, aerial, twin_id, twin, rec, aer, provenance, warnings, link)


# ------------------------------------------------------------------ solar (app/solar.py)


def solar_inputs(b: Building) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any] | None, list[str]]:
    """The CoStar, Vexcel and lease inputs solar.screen expects, from either the kit or a fixture."""
    rec, aer = b.record_raw, b.aerial_raw
    notes: list[str] = []
    gba = rec.get("gba_sqft")
    if not gba:
        gba = b.records.rba_sqft
        notes.append("building load estimated on the listed rentable area (no gross area on record)")
    costar_in = {
        "property_id": b.property_id,
        "property_type": rec.get("property_type") or SOLAR_TYPE.get(b.records.building_type, "Office"),
        "city": rec.get("city"),
        "gba_sqft": gba,
        "stories": b.records.stories,
        "year_built": rec.get("year_built"),
        "roof_renovation_years": rec.get("roof_renovation_years") or [],
        "owner_occupied": rec.get("owner_occupied"),
        "tenancy_type": rec.get("tenancy_type"),
        "leed_end_years": rec.get("leed_end_years") or [],
    }
    objects = aer.get("roof_objects") or {}
    if isinstance(objects, list):  # synthetic fixture format [{type, count}]
        objects = {_OBJECT_KIND.get(str(o.get("type", "")).lower(), str(o.get("type", "")).lower()): int(o.get("count") or 0)
                   for o in objects}
    aerial_in = {**aer, "roof_objects": objects, "roof_perimeter_ft": aer.get("roof_perimeter_ft") or aer.get("perimeter_ft")}
    lease = None
    if str(rec.get("source", "")).startswith("costar-kit"):
        try:
            lease = costar.lease_profile(b.property_id)
        except (costar.CoStarError, OSError):
            notes.append("lease data unavailable")
    return costar_in, aerial_in, lease, notes


def screen_solar(b: Building) -> solar.SolarScreen:
    costar_in, aerial_in, lease, notes = solar_inputs(b)
    s = solar.screen(costar_in, aerial_in, lease)
    s.warnings = notes + s.warnings
    return s

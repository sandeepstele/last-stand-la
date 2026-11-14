"""Data layers: CoStar records, Vexcel aerial attributes, Matterport twin.

Every loader returns data WITH provenance (`source`, `synthetic`), and the verifier loads
numbers here by property id, never from numbers an LLM typed into a tool call.

Modes (env): RADAR_LAYER_COSTAR / RADAR_LAYER_VEXCEL = cached | live (live = the CoStar
toolkit, wired in spike S2), RADAR_MATTERPORT = cached | live.
Everything here blocks (files, HTTP): call it through asyncio.to_thread from async code.

Licensing: real CoStar / Vexcel / Matterport data must not reach the public repo.
.gitignore ignores fixtures/*/* except the synthetic TEST-* files.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app import interior, matterport
from app.verify import Aerial, Records

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"
PROPERTY_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


class LayerError(RuntimeError):
    pass


def check_property_id(property_id: str) -> str:
    pid = str(property_id).strip()
    if not PROPERTY_ID.match(pid):
        raise LayerError(f"invalid property id: {property_id!r}")
    return pid


def _mode(layer: str) -> str:
    return os.environ.get(f"RADAR_LAYER_{layer.upper()}", "cached").strip().lower()


def _fixture(layer: str, property_id: str) -> dict[str, Any]:
    pid = check_property_id(property_id)
    path = FIXTURES / layer / f"{pid}.json"
    if not path.exists():
        raise LayerError(f"no cached {layer} data for {pid}")
    data = json.loads(path.read_text())
    data["synthetic"] = bool(data.get("synthetic", False))
    data.setdefault("source", f"cache:{layer}/{pid}.json")
    return data


def get_record(property_id: str) -> dict[str, Any]:
    if _mode("costar") == "live":
        raise LayerError("live CoStar toolkit is not wired yet (spike S2); use cached mode")
    return _fixture("costar", property_id)


def get_aerial(property_id: str) -> dict[str, Any]:
    if _mode("vexcel") == "live":
        raise LayerError("live Vexcel access is not wired yet (spike S2); use cached mode")
    return _fixture("vexcel", property_id)


def get_twin(property_id: str) -> tuple[str | None, interior.InteriorProfile | None]:
    """The Matterport twin linked to this property in its CoStar record, if any."""
    model_id = get_record(property_id).get("matterport_model_id")
    if not model_id:
        return None, None
    return model_id, interior.profile(matterport.fetch_layout(model_id))


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

    @property
    def synthetic(self) -> bool:
        return any(p.get("synthetic") for p in self.provenance.values())


def _positive(raw: dict[str, Any], key: str, layer: str) -> float:
    value = raw.get(key)
    if not isinstance(value, (int, float)) or value <= 0:
        raise LayerError(f"{layer} data has no usable {key}")
    return float(value)


def load_building(property_id: str) -> Building:
    """Everything the verifier needs, validated. Raises LayerError with a readable message."""
    pid = check_property_id(property_id)
    rec, aer = get_record(pid), get_aerial(pid)
    records = Records(
        rba_sqft=_positive(rec, "rba_sqft", "CoStar"),
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
        perimeter_ft=aer.get("perimeter_ft"),
    )
    warnings: list[str] = []
    try:
        twin_id, twin = get_twin(pid)
    except (matterport.MatterportError, LayerError) as e:
        twin_id, twin = rec.get("matterport_model_id"), None
        warnings.append(f"twin unavailable: {e}")
    provenance = {
        "costar": {"source": rec["source"], "synthetic": rec["synthetic"]},
        "vexcel": {"source": aer["source"], "synthetic": aer["synthetic"]},
    }
    if twin_id:
        provenance["matterport"] = {
            "source": f"{os.environ.get('RADAR_MATTERPORT', 'cached')}:{twin_id}",
            "synthetic": False,
            "linked_by": "costar record (synthetic link)" if rec["synthetic"] else "costar record",
        }
    return Building(pid, records, aerial, twin_id, twin, rec, aer, provenance, warnings)

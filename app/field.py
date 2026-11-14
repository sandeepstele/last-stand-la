"""Field checks: an iPhone LiDAR (Apple RoomPlan) scan uploaded by the Radar Field app.

What a scan can establish (iPhone LiDAR report in the private planning repo):
- the clear ceiling height of the scanned room, about +/-5 cm (RoomPlan is designed for <= 3.6 m)
- the net interior area of the scanned room(s), about +/-3% (a lower bound, never rentable area)
- relative floor elevations within ONE session, about +/-15 cm at best (inferred)

Rules that keep it honest:
1. Ceiling height only CAPS the number of floors (floor-to-floor always exceeds clear height).
2. "No lower level" counts only when the operator attests they looked (searched_below).
3. A lower level counts only if the first room scanned was at the entrance (first_room_at_entrance).
4. A stand-in scan (a room that is not the building being verified) is a preview: it never changes a verdict.

Storage: the LangGraph Store, namespace ("field", <property_id>), key = scan_id. The raw
RoomPlan JSON is parsed and dropped (it stays on the phone); only the parsed scan is stored.
"""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass, field, fields
from datetime import UTC, datetime
from statistics import median
from typing import Any

SQFT_PER_M2 = 10.7639
MAX_CEILING_M = 3.6  # RoomPlan design limit
LEVEL_GAP_M = 1.0  # floor elevations closer than this are the same level
BELOW_LEVEL_M = -2.0  # a floor this far below the first room's floor is a lower level
PROPERTY_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
SCAN_ID = re.compile(r"^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$")


class FieldScanError(ValueError):
    pass


@dataclass
class FieldScan:
    scan_id: str
    property_id: str
    ceiling_height_m: float | None  # None when missing or above RoomPlan's 3.6 m limit
    net_area_m2: float
    level_offsets_m: list[float]
    rooms: int
    searched_below: bool = False
    stand_in: bool = True
    first_room_at_entrance: bool = False
    source: dict[str, Any] = field(default_factory=dict)
    ceiling_tol_m: float = 0.05
    area_tol_pct: float = 3.0
    flags: list[str] = field(default_factory=list)
    received_at: str = ""

    @property
    def levels_below(self) -> list[float]:
        if not self.first_room_at_entrance:
            return []
        return [o for o in self.level_offsets_m if o <= BELOW_LEVEL_M]

    @property
    def net_area_sqft(self) -> float:
        return round(self.net_area_m2 * SQFT_PER_M2)

    def to_dict(self) -> dict[str, Any]:
        out = asdict(self)
        out["levels_below"] = self.levels_below
        out["net_area_sqft"] = self.net_area_sqft
        return out

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> FieldScan:
        names = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in data.items() if k in names})


def max_floors(height_m: float | None, scan: FieldScan | None) -> int | None:
    """Upper bound on above-grade floors, because floor-to-floor always exceeds clear height.
    Valid only if the scanned room is a typical floor (not a lobby or a double-height space)."""
    if scan is None or height_m is None or scan.ceiling_height_m is None:
        return None
    return max(1, math.floor(height_m / (scan.ceiling_height_m - scan.ceiling_tol_m)))


# ---------------------------------------------------------------- RoomPlan JSON


def _flat(value: Any) -> list[float]:
    if isinstance(value, bool):
        return []
    if isinstance(value, (int, float)):
        return [float(value)]
    if isinstance(value, dict):
        return [x for v in value.values() for x in _flat(v)]
    if isinstance(value, list):
        return [x for v in value for x in _flat(v)]
    return []


def _surfaces(raw: Any, key: str) -> list[dict]:
    if isinstance(raw, list):  # CapturedRoomArray
        return [s for item in raw for s in _surfaces(item, key)]
    if not isinstance(raw, dict):
        return []
    if raw.get(key):
        return [s for s in raw[key] if isinstance(s, dict)]
    return [s for room in raw.get("rooms") or [] for s in _surfaces(room, key)]


def _first_room_floors(raw: Any) -> list[dict]:
    if isinstance(raw, list) and raw:
        return _first_room_floors(raw[0])
    if isinstance(raw, dict):
        if raw.get("rooms"):
            return _first_room_floors(raw["rooms"][0])
        return [s for s in raw.get("floors") or [] if isinstance(s, dict)]
    return []


def _elevation(surface: dict) -> float | None:
    t = _flat(surface.get("transform"))
    return t[13] if len(t) == 16 else None  # column-major: columns[3].y, world Y is up


def _shoelace(points: list[tuple[float, float]]) -> float:
    if len(points) < 3:
        return 0.0
    s = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(points, points[1:] + points[:1]))
    return abs(s) / 2


def _area(surface: dict) -> float:
    corners = [c for c in (_flat(c) for c in surface.get("polygonCorners") or []) if len(c) >= 3]
    if len(corners) >= 3:
        return max(
            _shoelace([(c[0], c[1]) for c in corners]),
            _shoelace([(c[0], c[2]) for c in corners]),
            _shoelace([(c[1], c[2]) for c in corners]),
        )
    d = sorted(_flat(surface.get("dimensions"))[:3], reverse=True)
    return d[0] * d[1] if len(d) >= 2 else 0.0


def _cluster(elevations: list[float], reference: float) -> list[float]:
    clusters: list[list[float]] = []
    for e in sorted(elevations):
        if clusters and e - clusters[-1][-1] < LEVEL_GAP_M:
            clusters[-1].append(e)
        else:
            clusters.append([e])
    return [round(median(c) - reference, 2) for c in clusters]


def parse_roomplan(raw: Any) -> dict[str, Any]:
    """Ceiling height, net floor area and level offsets from RoomPlan's Codable JSON
    (a CapturedRoom, a CapturedStructure or a list of CapturedRooms)."""
    walls, floors = _surfaces(raw, "walls"), _surfaces(raw, "floors")
    heights = sorted(h for w in walls if len(d := _flat(w.get("dimensions"))) >= 2 and (h := d[1]) > 0.5)
    elevations = [e for f in floors if (e := _elevation(f)) is not None]
    first = [e for f in _first_room_floors(raw) if (e := _elevation(f)) is not None]
    reference = first[0] if first else (min(elevations) if elevations else 0.0)
    if isinstance(raw, list):
        rooms = len(raw)
    elif isinstance(raw, dict):
        rooms = len(raw.get("rooms") or []) or 1
    else:
        rooms = 0
    return {
        "ceiling_height_m": round(median(heights), 3) if heights else None,
        "net_area_m2": round(sum(_area(f) for f in floors), 2),
        "level_offsets_m": _cluster(elevations, reference) if elevations else [],
        "rooms": rooms,
        "walls": len(walls),
        "floors": len(floors),
    }


def _as_bool(payload: dict[str, Any], key: str, default: bool) -> bool:
    value = payload.get(key, default)
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip().lower() in ("true", "false"):
        return value.strip().lower() == "true"
    raise FieldScanError(f"{key} must be true or false")


def parse_payload(payload: dict[str, Any]) -> FieldScan:
    if not isinstance(payload, dict):
        raise FieldScanError("payload must be a JSON object")
    property_id = str(payload.get("property_id", "")).strip()
    scan_id = str(payload.get("scan_id", "")).strip()
    if not PROPERTY_ID.match(property_id):
        raise FieldScanError("property_id must start with a letter or digit and use only letters, digits, '_' or '-'")
    if not SCAN_ID.match(scan_id):
        raise FieldScanError("scan_id must be a UUID")

    summary = payload.get("summary") if isinstance(payload.get("summary"), dict) else {}
    measured = parse_roomplan(payload["roomplan"]) if payload.get("roomplan") is not None else {}
    flags: list[str] = []
    if not measured.get("walls") and not measured.get("floors"):
        measured = {}
        flags.append("RoomPlan JSON not parsed on the server; using the phone's own numbers")

    def pick(key: str, default: Any) -> Any:
        value = measured.get(key)
        return value if value not in (None, [], 0, 0.0) else summary.get(key, default)

    ceiling = pick("ceiling_height_m", None)
    phone_ceiling = summary.get("ceiling_height_m")
    if measured and ceiling is not None and isinstance(phone_ceiling, (int, float)) and abs(ceiling - phone_ceiling) > 0.05:
        flags.append(f"server ceiling {ceiling:.2f} m differs from phone {phone_ceiling:.2f} m")
    if ceiling is not None and ceiling > MAX_CEILING_M:
        flags.append(f"ceiling {ceiling:.2f} m is above RoomPlan's 3.6 m design limit: unverified")
        ceiling = None
    levels = [float(x) for x in pick("level_offsets_m", []) if isinstance(x, (int, float))]
    if len(levels) > 1:
        flags.append("several levels in one session: offsets about +/-15 cm at best (inferred)")

    return FieldScan(
        scan_id=scan_id,
        property_id=property_id,
        ceiling_height_m=ceiling,
        net_area_m2=float(pick("net_area_m2", 0.0) or 0.0),
        level_offsets_m=levels,
        rooms=int(pick("rooms", 1) or 1),
        searched_below=_as_bool(payload, "searched_below", False),
        stand_in=_as_bool(payload, "stand_in", True),
        first_room_at_entrance=_as_bool(payload, "first_room_at_entrance", False),
        source={k: payload.get(k) for k in ("operator", "captured_at", "device", "notes", "roomplan_type")},
        flags=flags + [w for w in summary.get("warnings", []) if isinstance(w, str)],
        received_at=datetime.now(UTC).isoformat(),
    )


# ---------------------------------------------------------------- storage (LangGraph Store)


async def save_scan(store: Any, payload: dict[str, Any]) -> FieldScan:
    scan = parse_payload(payload)
    await store.aput(("field", scan.property_id), scan.scan_id, scan.to_dict())
    return scan


async def list_scans(store: Any, property_id: str) -> list[FieldScan]:
    if store is None or not PROPERTY_ID.match(str(property_id)):
        return []
    items = await store.asearch(("field", property_id), limit=100)
    scans = [FieldScan.from_dict(item.value) for item in items]
    return sorted(scans, key=lambda s: s.received_at, reverse=True)


async def latest_scan(store: Any, property_id: str, include_stand_in: bool = False) -> FieldScan | None:
    for scan in await list_scans(store, property_id):
        if include_stand_in or not scan.stand_in:
            return scan
    return None


def preview(scan: FieldScan, height_m: float | None = None, listed_stories: int | None = None) -> str:
    """One line for the phone and the verifier card."""
    parts = []
    if scan.ceiling_height_m is not None:
        parts.append(f"Ceiling {scan.ceiling_height_m:.2f} m ± {scan.ceiling_tol_m:.2f}")
        cap = max_floors(height_m, scan)
        if cap is not None:
            listed = f" (listed: {listed_stories})" if listed_stories else ""
            parts.append(f"at most {cap} floor(s) fit in {height_m:.1f} m{listed}")
    else:
        parts.append("No usable ceiling height")
    parts.append(f"{scan.net_area_m2:.1f} m² interior ± {scan.area_tol_pct:.0f}%")
    if scan.levels_below:
        parts.append(f"lower level at {scan.levels_below[0]:+.1f} m (inferred)")
    text = "; ".join(parts) + "."
    return ("Stand-in room, preview only: " + text) if scan.stand_in else text

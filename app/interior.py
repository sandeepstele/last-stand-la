"""What a Matterport twin says about a building's levels. Pure functions, no I/O.

Verified on Matterport's sandbox demo model (Fri Nov 13):
- Model API positions are Z-up and in meters (floors ~3.3-3.6 apart).
- The origin is the first scan, which is NOT necessarily on the lowest floor.
- Some scans have no floor (unplaced 360 views) and some are outliers (stairs), so each
  level uses the MEDIAN z of its scans.

Guards added after review (docs/ENGINEERING.md):
- A level's scanned extent (padded bounding box of its scan positions) is recorded, so the
  verifier can tell a whole-building twin from a one-suite twin.
- Mezzanines are counted as LEVELS (greedy walk up from the lowest level), not as pairs.
- "Entrance" = level of the scan nearest the origin (first scan). That is a heuristic; when a
  level below it is labeled like a ground floor ("Floor 1", "Lobby", ...), the entrance is
  marked ambiguous and nothing below it is treated as a basement.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from statistics import median
from typing import Any

MEZZANINE_MAX_M = 2.6  # a level closer than this to the last full level is a mezzanine
EXTENT_PAD_M = 1.5  # scan positions sit inside the walls; pad the bounding box on each side
SQFT_PER_M2 = 10.7639
_GROUND_LABEL = re.compile(r"^\s*((floor|level|lvl|fl)\s*0?1|ground|lobby|street|main|g|gf|1st|first)\b", re.I)


@dataclass
class Level:
    floor_id: str
    sequence: int
    label: str
    n_scans: int
    median_z_m: float | None
    extent_m2: float = 0.0  # padded bounding box of this level's scan positions
    mezzanine: bool = False


@dataclass
class InteriorProfile:
    model_id: str
    levels: list[Level]  # scanned levels bottom to top, then floors with no scans
    entrance_floor_id: str | None
    levels_below_entrance: list[Level]
    levels_above_entrance: list[Level]
    floor_to_floor_m: list[float]  # gaps between consecutive FULL levels
    typical_floor_to_floor_m: float | None
    mezzanine_levels: list[str]
    unplaced_scans: int
    entrance_ambiguous: bool = False
    notes: list[str] = field(default_factory=list)

    @property
    def scanned_levels(self) -> int:
        return sum(1 for lv in self.levels if lv.n_scans > 0)

    @property
    def height_from_entrance_m(self) -> float | None:
        """Entrance floor to the top of the highest full level (its floor plus one floor-to-floor)."""
        entrance = next((lv for lv in self.levels if lv.floor_id == self.entrance_floor_id), None)
        tops = [lv.median_z_m for lv in self.levels_above_entrance if not lv.mezzanine and lv.median_z_m is not None]
        if entrance is None or entrance.median_z_m is None or self.typical_floor_to_floor_m is None:
            return None
        return round(max(tops, default=entrance.median_z_m) - entrance.median_z_m + self.typical_floor_to_floor_m, 2)

    @property
    def full_levels_from_entrance(self) -> int:
        """Entrance level plus full (non-mezzanine) levels above it."""
        if self.entrance_floor_id is None:
            return sum(1 for lv in self.levels if lv.n_scans > 0 and not lv.mezzanine)
        return 1 + sum(1 for lv in self.levels_above_entrance if not lv.mezzanine)

    def coverage(self, footprint_sqft: float) -> float:
        """Largest single-level scanned extent as a share of the building footprint (0-1)."""
        if footprint_sqft <= 0:
            return 0.0
        best = max((lv.extent_m2 for lv in self.levels), default=0.0)
        return min(1.0, best * SQFT_PER_M2 / footprint_sqft)


def _extent_m2(locs: list[dict[str, Any]]) -> float:
    xs = [loc["position"]["x"] for loc in locs]
    ys = [loc["position"]["y"] for loc in locs]  # Model API is Z-up, so x/y are horizontal
    if not xs:
        return 0.0
    return (max(xs) - min(xs) + 2 * EXTENT_PAD_M) * (max(ys) - min(ys) + 2 * EXTENT_PAD_M)


def profile(layout: dict[str, Any]) -> InteriorProfile:
    floors = {f["id"]: f for f in layout.get("floors") or []}
    by_floor: dict[str, list[dict[str, Any]]] = {fid: [] for fid in floors}
    unplaced = 0
    for loc in layout.get("locations") or []:
        fid = (loc.get("floor") or {}).get("id")
        if not fid or not loc.get("position"):
            unplaced += 1
            continue
        by_floor.setdefault(fid, []).append(loc)

    notes: list[str] = []
    levels: list[Level] = []
    for fid, locs in by_floor.items():
        f = floors.get(fid, {})
        zs = [loc["position"]["z"] for loc in locs]
        levels.append(
            Level(
                floor_id=fid,
                sequence=f.get("sequence", -1),
                label=f.get("label") or fid,
                n_scans=len(zs),
                median_z_m=round(median(zs), 3) if zs else None,
                extent_m2=round(_extent_m2(locs), 1),
            )
        )
        if fid not in floors:
            notes.append(f"floor {fid} has scans but is missing from floors{{}}")

    scanned = sorted((lv for lv in levels if lv.median_z_m is not None), key=lambda lv: lv.median_z_m)
    empty = [lv for lv in levels if lv.median_z_m is None]
    if [lv.sequence for lv in scanned] != sorted(lv.sequence for lv in scanned):
        notes.append("floor sequence order disagrees with scan elevation order; using elevation")
    if empty:
        notes.append(f"{len(empty)} floor(s) have no placed scans: {[lv.label for lv in empty]}")

    # Mezzanines: walk up from the lowest level; a level within MEZZANINE_MAX_M of the last
    # FULL level is a mezzanine (so L1 / M / L2 yields one mezzanine, not two pairs).
    anchor: Level | None = None
    full: list[Level] = []
    for lv in scanned:
        if anchor is not None and lv.median_z_m - anchor.median_z_m < MEZZANINE_MAX_M:  # type: ignore[operator]
            lv.mezzanine = True
        else:
            anchor = lv
            full.append(lv)
    gaps = [round(b.median_z_m - a.median_z_m, 3) for a, b in zip(full, full[1:])]  # type: ignore[operator]

    # Entrance: level of the placed scan nearest the origin (the first scan).
    entrance_id, best = None, math.inf
    for fid, locs in by_floor.items():
        for loc in locs:
            p = loc["position"]
            d = math.sqrt(p["x"] ** 2 + p["y"] ** 2 + p["z"] ** 2)
            if d < best:
                best, entrance_id = d, fid
    idx = next((i for i, lv in enumerate(scanned) if lv.floor_id == entrance_id), None)

    # If a level below the first scan is labeled like a ground floor, the scan probably started
    # upstairs: re-anchor the entrance at that ground-labeled level.
    ambiguous = False
    if idx is not None:
        ground = [i for i in range(idx) if _GROUND_LABEL.match(scanned[i].label)]
        if ground:
            ambiguous = True
            idx = ground[-1]
            entrance_id = scanned[idx].floor_id
            notes.append(
                f"the first scan was not on the ground-labeled level '{scanned[idx].label}'; "
                "treating that level as the entrance (check in Matterport Workshop)"
            )
    below = scanned[:idx] if idx is not None else []
    above = scanned[idx + 1 :] if idx is not None else []

    return InteriorProfile(
        model_id=layout.get("id", "?"),
        levels=scanned + empty,
        entrance_floor_id=entrance_id,
        levels_below_entrance=below,
        levels_above_entrance=above,
        floor_to_floor_m=gaps,
        typical_floor_to_floor_m=round(median(gaps), 2) if gaps else None,
        mezzanine_levels=[lv.label for lv in scanned if lv.mezzanine],
        unplaced_scans=unplaced,
        entrance_ambiguous=ambiguous,
        notes=notes,
    )

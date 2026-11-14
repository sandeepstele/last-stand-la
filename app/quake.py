"""Earthquake shaking at each building, from a USGS ShakeMap (cached by scripts/fetch_public.py).

The demo trigger is a LABELED REPLAY of the 1994 Northridge earthquake (USGS ci3144585, M6.7): there has been
no strong LA quake this season, so we replay a real one. Every result carries replay=True and the event's
real date, and the agent must say "replay of the 1994 Northridge earthquake", never imply it is happening now.

Intensity is the ShakeMap's MMI (Modified Mercalli, I-X) at the grid cell nearest the building
(cells are about 1.8 km apart). VI = felt by all, some damage; VII = damage to poorly built structures;
VIII+ = considerable damage to ordinary buildings, heavy to poorly built ones.
"""

from __future__ import annotations

import json
import math
import re
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any

PUBLIC = Path(__file__).resolve().parent.parent / "fixtures" / "public"
DEFAULT_EVENT = "ci3144585"
MMI_WORDS = {5: "moderate", 6: "strong", 7: "very strong", 8: "severe", 9: "violent", 10: "extreme"}


class QuakeDataMissing(RuntimeError):
    pass


@lru_cache(maxsize=2)
def event(event_id: str = DEFAULT_EVENT) -> dict[str, Any]:
    p = PUBLIC / f"usgs_{event_id}.json"
    if not p.exists():
        raise QuakeDataMissing(f"{p} is missing: run python scripts/fetch_public.py")
    e = json.loads(p.read_text())
    lon, lat, depth = e["geometry"]["coordinates"]
    return {"event_id": event_id, "magnitude": e["properties"]["mag"], "place": e["properties"]["place"],
            "time": datetime.fromtimestamp(e["properties"]["time"] / 1000, UTC).isoformat(timespec="minutes"),
            "lat": lat, "lon": lon, "depth_km": depth}


@lru_cache(maxsize=2)
def _grid(event_id: str = DEFAULT_EVENT) -> tuple[dict[str, float], list[list[float]]]:
    p = PUBLIC / f"shakemap_{event_id}_grid.xml"
    if not p.exists():
        raise QuakeDataMissing(f"{p} is missing: run python scripts/fetch_public.py")
    text = p.read_text()
    spec = re.search(r"<grid_specification ([^>]*)/>", text).group(1)
    s = {k: float(v) for k, v in re.findall(r'(\w+)="([-\d.]+)"', spec)}
    data = text[text.index("<grid_data>") + 11: text.index("</grid_data>")]
    nlon = int(s["nlon"])
    rows = [list(map(float, line.split()[:5])) for line in data.strip().splitlines()]
    # rows go west->east, then north->south; index them as a dense grid
    grid = [rows[i:i + nlon] for i in range(0, len(rows), nlon)]
    return s, grid


def shaking(lat: float, lon: float, event_id: str = DEFAULT_EVENT) -> dict[str, Any] | None:
    s, grid = _grid(event_id)
    if not (s["lat_min"] <= lat <= s["lat_max"] and s["lon_min"] <= lon <= s["lon_max"]):
        return None
    i = round((s["lat_max"] - lat) / s["nominal_lat_spacing"])
    j = round((lon - s["lon_min"]) / s["nominal_lon_spacing"])
    i, j = min(max(i, 0), len(grid) - 1), min(max(j, 0), len(grid[0]) - 1)
    _, _, mmi, pga, pgv = grid[i][j]
    return {"mmi": round(mmi, 1), "mmi_words": MMI_WORDS.get(int(mmi), "light" if mmi < 5 else "extreme"),
            "pga_g": round(pga / 100, 3), "pgv_cm_s": round(pgv, 1)}


def km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


PRIORITY = {"past_due": 0, "unfinished": 1, "material_conflict": 2, "not_proven_safe": 3, "stale_entry": 4, "work_underway": 5}


def _rank_key(b: dict[str, Any]) -> tuple:
    keys = {h["key"] for h in b["hypotheses"]}
    if any(h.get("past_due") for h in b["hypotheses"]):
        keys.add("past_due")
    cls = min((PRIORITY[k] for k in keys if k in PRIORITY), default=9)
    return (cls, -(b["shaking"] or {}).get("mmi", 0))


def replay(event_id: str = DEFAULT_EVENT, limit: int = 8) -> dict[str, Any]:
    """Rank every LA kit building with a seismic finding by how hard the replayed quake shook it."""
    from app import costar, retrofit_lists

    ev = event(event_id)
    hits = []
    for a in retrofit_lists.portfolio():
        rec = costar.get(a["property_id"])
        if rec.get("latitude") is None:
            continue
        sh = shaking(rec["latitude"], rec["longitude"], event_id)
        hits.append({**a, "shaking": sh, "km_from_epicenter": round(km(ev["lat"], ev["lon"], rec["latitude"], rec["longitude"]), 1)})
    hits.sort(key=_rank_key)
    strong = [h for h in hits if (h["shaking"] or {}).get("mmi", 0) >= 7]
    # the 56 real ones: unfinished, minus stale entries (the listed building was probably replaced)
    unfinished = [h for h in hits if h["status"] == "unfinished" and not any(x["key"] == "stale_entry" for x in h["hypotheses"])]
    return {
        "replay": True,
        "label": f"Replay of the {ev['time'][:4]} {ev['place']} (M{ev['magnitude']}), not a live event",
        "event": ev,
        "buildings_with_findings": len(hits),
        "unfinished": len(unfinished),
        "unfinished_shaken_mmi_7_plus": sum(1 for h in unfinished if (h["shaking"] or {}).get("mmi", 0) >= 7),
        "shaken_mmi_7_plus": len(strong),
        "top": [{k: h[k] for k in ("property_id", "address", "year_built", "stories", "units", "costar_material", "status",
                                   "shaking", "km_from_epicenter")}
                | {"findings": [h2["key"] for h2 in h["hypotheses"]],
                   "past_due": any(h2.get("past_due") for h2 in h["hypotheses"])}
                for h in hits[:max(1, min(limit, 15))]],
        "source": "USGS ShakeMap ci3144585 + LA retrofit lists (fixtures/public)",
    }

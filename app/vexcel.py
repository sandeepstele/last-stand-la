"""Vexcel API 2.0 adapter, from the organizers' Hackathon Quickstart, corrected against real
responses on Fri Nov 13 (team key, Houston):

- Auth header X-API-KEY (team key in VEXCEL_API_KEY; never in GitHub, slides or screenshots).
- WKT is LONGITUDE first: POINT(lon lat), srid=4326.
- GET property/extract: `latest=true` still returns one feature PER CAPTURE (we saw 8, 2021-2026,
  unordered). Pick the newest by `metadata.ortho-date-estimate`. Older captures are kept for change
  detection (footprint over time).
- Roof height needs include=`precomputed,roof-height` (fast, ~0.3 s): `roof-characteristics.height`
  and `.elevation`, in feet with unit-system=imperial. include=calculated did NOT return heights.
- Roof condition: `roof-characteristics.condition.precise-value`. Higher is better on about 1-5
  (same house: 3.69 with 33.6% discoloration vs 4.4-4.9 clean). Inferred, not documented.
- A point can land on a small structure of a big parcel (a 2,065 sq ft shed instead of a
  1.23M sq ft warehouse): choose the structure containing the point, and let the verifier flag
  a footprint that can't be the building.
- 429 = too fast: retry with exponential backoff.
"""

from __future__ import annotations

import math
import os
import random
import re
import time
from typing import Any

import httpx

API = "https://api.vexcelgroup.com/v2"
LAYERS = "urban,urban-r,wide-area,urban-g"
FT_TO_M = 0.3048
SQM_TO_SQFT = 10.7639
MAX_RETRIES = 5
DEFECTS_REROOF = ("structural-damage", "missing-material", "tarp")


class VexcelError(RuntimeError):
    pass


def _client(transport: httpx.BaseTransport | None = None) -> httpx.Client:
    key = os.environ.get("VEXCEL_API_KEY")
    if not key:
        raise VexcelError("VEXCEL_API_KEY is not set (put the team key in .env)")
    return httpx.Client(base_url=API, headers={"X-API-KEY": key}, timeout=120, transport=transport)


def _send(client: httpx.Client, method: str, path: str, sleep=time.sleep, **kwargs) -> httpx.Response:
    for attempt in range(MAX_RETRIES + 1):
        response = client.request(method, path, **kwargs)
        if response.status_code != 429 or attempt == MAX_RETRIES:
            return response
        sleep(min(2**attempt, 30) + random.random())
    return response  # pragma: no cover


def property_extract(lat: float, lon: float, *, buffer_m: float | None = None,
                     transport: httpx.BaseTransport | None = None, sleep=time.sleep) -> dict[str, Any]:
    params: dict[str, Any] = {
        "wkt": f"POINT({lon} {lat})", "srid": 4326, "layer": LAYERS, "latest": "true",
        "include": "precomputed,roof-height", "unit-system": "imperial",
    }
    if buffer_m:
        params["buffer-meter"] = buffer_m
    with _client(transport) as client:
        r = _send(client, "GET", "property/extract", sleep=sleep, params=params)
    if r.status_code == 401:
        raise VexcelError("401: the API rejected VEXCEL_API_KEY")
    if r.status_code == 404:
        raise VexcelError("404: no property record at this point (road, water, outside the key's area, or lat/lon swapped)")
    if r.status_code >= 400:
        raise VexcelError(f"property/extract failed ({r.status_code}): {r.text[:300]}")
    return r.json()


def detect(parcel_wkt: str, labels: list[str], *, threshold: float = 0.5,
           transport: httpx.BaseTransport | None = None, sleep=time.sleep) -> dict[str, Any]:
    """Open-vocabulary detection on the parcel's ortho (e.g. labels=["HVAC unit", "skylight"])."""
    body = {
        "wkt": parcel_wkt, "srid": 4326, "buffer-meter": 0,
        "images": [{"endpoint": "ortho/extract", "request": {"layer": LAYERS, "srid": 4326, "wkt": parcel_wkt, "crop": "bounding_box"}}],
        "model-input": {"elements": [{"label": l, "model": "sam3", "detection-threshold": threshold} for l in labels],
                        "include": ["bbox", "confidence"]},
    }
    with _client(transport) as client:
        r = _send(client, "POST", "elements/detect", sleep=sleep, json=body, timeout=300)
    if r.status_code >= 400:
        raise VexcelError(f"elements/detect failed ({r.status_code}): {r.text[:300]}")
    return r.json()


# ---------------------------------------------------------------- geometry (no shapely needed)


def ring_lonlat(geometry: Any) -> list[tuple[float, float]]:
    """Outer ring of a GeoJSON Polygon/MultiPolygon or a WKT POLYGON/MULTIPOLYGON, as (lon, lat)."""
    if isinstance(geometry, dict):
        coords = geometry.get("coordinates") or []
        if geometry.get("type") == "MultiPolygon":
            coords = max(coords, key=lambda poly: len(poly[0])) if coords else []
        return [(float(p[0]), float(p[1])) for p in (coords[0] if coords else [])]
    if isinstance(geometry, str):
        inner = re.search(r"\(\(\s*([^()]+?)\s*\)", geometry)
        if inner:
            return [(float(a), float(b)) for a, b, *_ in (pair.split() for pair in inner.group(1).split(","))]
    return []


def to_local_m(ring: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Equirectangular projection around the ring's centroid: fine at building scale."""
    if not ring:
        return []
    lon0 = sum(p[0] for p in ring) / len(ring)
    lat0 = sum(p[1] for p in ring) / len(ring)
    k = 111_320.0
    return [(round((lon - lon0) * k * math.cos(math.radians(lat0)), 2), round((lat - lat0) * k, 2)) for lon, lat in ring]


def area_sqft(ring: list[tuple[float, float]]) -> float:
    pts = to_local_m(ring)
    if len(pts) < 3:
        return 0.0
    s = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(pts, pts[1:] + pts[:1]))
    return abs(s) / 2 * SQM_TO_SQFT


def perimeter_ft(ring: list[tuple[float, float]]) -> float:
    pts = to_local_m(ring)
    if len(pts) < 2:
        return 0.0
    closed = pts if pts[0] == pts[-1] else pts + pts[:1]
    return sum(math.dist(a, b) for a, b in zip(closed, closed[1:])) / FT_TO_M


def bbox_ft(ring: list[tuple[float, float]]) -> tuple[float, float]:
    pts = to_local_m(ring)
    if not pts:
        return 0.0, 0.0
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return (max(xs) - min(xs)) / FT_TO_M, (max(ys) - min(ys)) / FT_TO_M


def contains(ring: list[tuple[float, float]], lon: float, lat: float) -> bool:
    inside, j = False, len(ring) - 1
    for i in range(len(ring)):
        (xi, yi), (xj, yj) = ring[i], ring[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


# ---------------------------------------------------------------- normalization


def _newest(features: list[dict[str, Any]]) -> dict[str, Any]:
    return max(features, key=lambda f: str((f.get("properties") or {}).get("metadata.ortho-date-estimate") or ""))


def _structure(structures: list[dict[str, Any]], lat: float | None, lon: float | None) -> tuple[dict[str, Any], str]:
    if lat is not None and lon is not None:
        for s in structures:
            ring = ring_lonlat(s.get("footprint.wkt"))
            if ring and contains(ring, lon, lat):
                return s, "contains the CoStar point"
    flagged = [s for s in structures if s.get("primary-structure")]
    if flagged:
        return flagged[0], "Vexcel primary structure"
    return max(structures, key=lambda s: s.get("footprint.area") or 0), "largest structure"


def normalize(raw: dict[str, Any], property_id: str, lat: float | None = None, lon: float | None = None) -> dict[str, Any]:
    """Vexcel property/extract response -> the aerial layer's normalized record."""
    features = raw.get("features") or []
    if not features:
        raise VexcelError("property/extract returned no features")
    newest = _newest(features)
    attrs = newest.get("properties") or {}
    structures = [s for s in attrs.get("structures") or [] if isinstance(s, dict)]
    if not structures:
        raise VexcelError("no structures on this parcel")
    s, chosen_by = _structure(structures, lat, lon)
    ring = ring_lonlat(s.get("footprint.wkt"))
    footprint = s.get("footprint.area") or (round(area_sqft(ring)) if ring else None)
    height_ft = s.get("roof-characteristics.height")
    width_ft, depth_ft = bbox_ft(ring)
    defects = {k.split(".")[1]: v for k, v in s.items() if k.startswith("roof-defects.") and k.count(".") == 2 and k.endswith(".percent") and v}
    severe = [d for d in DEFECTS_REROOF if s.get(f"roof-defects.{d}.detected")]
    objects = {k.split(".")[1]: v for k, v in s.items() if k.startswith("roof-objects.") and k.endswith(".count") and v}

    history = []
    for f in features:
        p = f.get("properties") or {}
        ss = [x for x in p.get("structures") or [] if isinstance(x, dict)]
        if ss:
            fs, _ = _structure(ss, lat, lon)
            history.append({"collection": p.get("metadata.collection"), "date": str(p.get("metadata.ortho-date-estimate") or "")[:10],
                            "footprint_sqft": round(fs.get("footprint.area") or 0)})
    history.sort(key=lambda h: h["date"])

    return {
        "property_id": property_id,
        "source": f"vexcel:{attrs.get('metadata.collection', 'unknown')}",
        "capture_date": str(attrs.get("metadata.ortho-date-estimate") or "")[:10],
        "synthetic": False,
        "lat": lat, "lon": lon,
        "structure_chosen_by": chosen_by,
        "structure_count": attrs.get("structure.count", len(structures)),
        "building_type": s.get("building-type.class"),
        "footprint_sqft": round(float(footprint)) if footprint else None,
        "footprint_polygon_m": to_local_m(ring) or None,
        "roof_perimeter_ft": round(perimeter_ft(ring)) if ring else None,
        "roof_max_dimension_ft": round(max(width_ft, depth_ft)) if ring else None,
        "height_m": round(height_ft * FT_TO_M, 2) if isinstance(height_ft, (int, float)) else None,
        "roof_shape": s.get("roof-characteristics.shape.value"),
        "roof_material": s.get("roof-characteristics.material.class"),
        "roof_condition": None,
        "roof_condition_score": s.get("roof-characteristics.condition.precise-value"),
        "roof_tree_cover_pct": s.get("roof-characteristics.tree-cover.percent") or 0.0,
        "roof_defects_pct": defects,
        "roof_defects_severe": severe,
        "roof_objects": objects,
        "existing_pv_sqft": s.get("roof-objects.solar-panel-photovoltaic.area") or 0.0,
        "roof_object_area_sqft": 0.0,  # counts only unless measured with elements/detect
        "setback_detected": None,
        "parcel_area_sqft": round(area_sqft(ring_lonlat(newest.get("geometry")))) or None,
        "inside_parcel": attrs.get("request-information.inside-parcel"),
        "footprint_history": history,
        "warnings": ["roof condition scale inferred (higher is better, about 1-5); verify with Vexcel"],
    }


def rooftop_area_sqft(detections: dict[str, Any]) -> tuple[float, dict[str, int]]:
    """Sum of detected bounding-box areas (an upper bound on equipment area) and counts per label."""
    total, counts = 0.0, {}
    for feat in detections.get("features") or []:
        label = (feat.get("properties") or {}).get("label", "?")
        for d in (feat.get("properties") or {}).get("detections") or []:
            total += area_sqft(ring_lonlat(d.get("bbox")))
            counts[label] = counts.get(label, 0) + 1
    return round(total), counts

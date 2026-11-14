"""Looking at the building: Vexcel imagery plus a two-pass Gemini vision read.

Images (cached in fixtures/vision/, gitignored: Vexcel imagery is licensed for the event):
  ortho      top-down image of the building's surroundings (any collection, or a dated one)
  oblique    45-degree side view from the newest collection that has one (urban layer only)

ask(): one specific question about the images, answered as JSON; then a skeptical second pass that sees
the same images and the first answer and must confirm it. If it doesn't, the result is "can't tell".
Vision is evidence, never a verdict: app/evidence.py caps its confidence shifts at +/-0.2.
Answers are cached per (property, question), so a rehearsed demo runs offline and gives the same answer.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import os
from pathlib import Path
from typing import Any

import httpx

from app import vexcel

CACHE = Path(__file__).resolve().parent.parent / "fixtures" / "vision"
VISION_MODEL = os.environ.get("RADAR_VISION_MODEL", "gemini-3.8-flash")


class VisionUnavailable(RuntimeError):
    pass


def _square_wkt(lat: float, lon: float, half_m: float) -> str:
    dlat = half_m / 111_320
    dlon = half_m / (111_320 * math.cos(math.radians(lat)))
    pts = [(lon - dlon, lat - dlat), (lon + dlon, lat - dlat), (lon + dlon, lat + dlat), (lon - dlon, lat + dlat), (lon - dlon, lat - dlat)]
    return "POLYGON((" + ", ".join(f"{x:.7f} {y:.7f}" for x, y in pts) + "))"


def _area(aer: dict[str, Any]) -> str:
    side_m = math.sqrt((aer.get("footprint_sqft") or 10_000) * 0.0929)
    return _square_wkt(aer["lat"], aer["lon"], max(25.0, side_m / 2 + 15))


def _post_image(path: str, body: dict[str, Any]) -> bytes:
    with vexcel._client() as c:
        r = vexcel._send(c, "POST", path, json=body, timeout=180)
    if r.status_code != 200 or not r.headers.get("content-type", "").startswith("image"):
        raise VisionUnavailable(f"Vexcel {path} returned {r.status_code}: {r.text[:200] if 'json' in r.headers.get('content-type', '') else ''}")
    return r.content


def ortho(pid: str, aer: dict[str, Any], collection: str | None = None) -> Path:
    tag = collection or "latest"
    out = CACHE / f"{pid}_ortho_{tag}.jpg"
    if out.exists():
        return out
    body: dict[str, Any] = {"wkt": _area(aer), "srid": 4326, "layer": "urban,urban-r,wide-area,urban-g", "crop": "bounding_box",
                            "image-format": "jpeg"}
    if collection:
        body["collection"] = collection
    CACHE.mkdir(parents=True, exist_ok=True)
    out.write_bytes(_post_image("ortho/extract", body))
    return out


def oblique(pid: str, aer: dict[str, Any]) -> Path | None:
    hits = sorted(CACHE.glob(f"{pid}_oblique_*.jpg"))
    if hits:
        return hits[0]
    wkt = _area(aer)
    with vexcel._client() as c:
        r = vexcel._send(c, "GET", "oriented/collections", timeout=120, params={
            "wkt": wkt, "srid": 4326, "layer": "urban", "product-type": "oblique", "include": "product-type,collection,last-capture-date"})
    if r.status_code == 404 or not r.is_success:
        return None
    feats = r.json().get("features") or []
    newest = max((f["properties"].get("last-capture-date") or "" for f in feats), default="")
    dirs = [d for d in ("oblique-south", "oblique-east", "oblique-west", "oblique-north")
            if any(f["properties"].get("product-type") == d and f["properties"].get("last-capture-date") == newest for f in feats)]
    if not dirs:
        return None
    CACHE.mkdir(parents=True, exist_ok=True)
    out = CACHE / f"{pid}_oblique_{dirs[0].split('-')[1]}.jpg"
    out.write_bytes(_post_image("oriented/extract", {"wkt": wkt, "srid": 4326, "layer": "urban", "product-type": dirs[0],
                                                     "rotation": "natural", "buffer-meter": 10, "crop": "bbox", "image-format": "jpeg"}))
    return out


# ------------------------------------------------------------------ vision


def _model():
    from app.agent import make_model

    return make_model(VISION_MODEL, "low", timeout=60, attempts=2)


def _image_part(path: Path) -> dict[str, Any]:
    return {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(path.read_bytes()).decode()}}


def _json(text: str) -> dict[str, Any]:
    t = text.strip().strip("`")
    t = t[t.index("{"): t.rindex("}") + 1] if "{" in t else "{}"
    return json.loads(t)


def _invoke(images: list[Path], prompt: str) -> dict[str, Any]:
    from langchain_core.messages import HumanMessage

    msg = HumanMessage(content=[{"type": "text", "text": prompt}, *[_image_part(p) for p in images]])
    out = _model().invoke([msg])
    text = out.content if isinstance(out.content, str) else "".join(b.get("text", "") for b in out.content if isinstance(b, dict))
    return _json(text)


def ask(pid: str, key: str, images: list[Path], question: str, choices: list[str]) -> dict[str, Any]:
    """Two-pass read. Returns {answer, observed, confirmed, second_look, images}; answer is 'cant_tell' unless confirmed."""
    h = hashlib.sha256((question + "|".join(p.name for p in images)).encode()).hexdigest()[:12]
    cached = CACHE / f"{pid}_{key}_{h}.json"
    if cached.exists():
        return json.loads(cached.read_text())
    labels = ", ".join(choices + ["cant_tell"])
    first = _invoke(images, (
        f"{question}\nAnswer only from what is visible. Reply with JSON: "
        f'{{"answer": one of [{labels}], "observed": "one sentence on what you see that decides it"}}.'))
    answer = first.get("answer") if first.get("answer") in choices else "cant_tell"
    second: dict[str, Any] = {"confirmed": False, "reason": "no claim to check"}
    if answer != "cant_tell":
        second = _invoke(images, (
            "You are a skeptical reviewer. Another analyst looked at these aerial images and claimed: "
            f'"{answer}" because "{first.get("observed", "")}". The question was: {question}\n'
            "Confirm only if the images clearly show it; low resolution, shadows, roofs-only views or ambiguity mean no. "
            'Reply with JSON: {"confirmed": true or false, "reason": "one sentence"}.'))
    result = {
        "answer": answer if second.get("confirmed") is True else "cant_tell",
        "first_answer": answer,
        "observed": first.get("observed", ""),
        "confirmed": second.get("confirmed") is True,
        "second_look": second.get("reason", ""),
        "images": [str(p) for p in images],
        "model": VISION_MODEL,
    }
    cached.write_text(json.dumps(result, indent=1))
    return result

"""Last Stand LA: the game's numbers, all computed in code (the model never sets one).

One district: the kit buildings within RADIUS_M of 122 7th St (254167), downtown LA. Each building is placed
from its CoStar coordinates; hero buildings with a clean Vexcel outline are extruded from it, the rest are boxes
from CoStar area and stories. Scores come from the records the auditor already reads:

  walls   CoStar's material, or, when the city's concrete list disagrees, the material_conflict case: the
          strength of each hypothesis's material weighted by its posterior (weigh_case), so evidence and a
          player's tip move it
  quake   the city's retrofit order (listed and unfinished = weak) and the 1994 Northridge shaking at the site
  roof    Vexcel roof shape and objects (skylights are ways in)
  people  employees CoStar records in the building, or apartments
  space   CoStar gross area and floors

Waves are a fixed, seeded script and every roll is seeded, so a rehearsed night replays the same way and the
replay keys (app/replay.py) stay stable. Wording stays hedged: a disagreement is "a gamble", never "wrong".
Game outcomes are not engineering assessments.
"""

from __future__ import annotations

import collections
import json
import math
import random
from functools import lru_cache
from pathlib import Path
from typing import Any

from app import costar, evidence, quake, retrofit_lists

CENTER_PID = "254167"
RADIUS_M = 900
SEED = 1990  # the demo night: holding the gamble loses wave 1, running to the fallback survives it (rolls stay in code)
HEROES = ("6375735", "254167", "52227")
NO_EXTRUDE = {"256390"}  # Vexcel's outline is 17 m tall for a 13-story record: likely another structure
DISCLAIMER = "Game outcome, not an engineering assessment"
FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"
VISION = FIXTURES / "vision"
K = 111_320.0
FLOOR_M = 3.8

MATERIAL = {"ReinforcedConcrete": "concrete", "Concrete": "concrete", "PrecastConcrete": "concrete", "Masonry": "masonry",
            "Steel": "steel", "Metal": "steel", "WoodFrame": "wood", "Wood": "wood"}
# How well each material keeps a horde out (game values).
WALLS = {"concrete": 85, "steel": 70, "masonry": 60, "wood": 30, "unknown": 45}
# What each material_conflict hypothesis says the walls are made of.
HYPOTHESIS_MATERIAL = {"city_list_current": "concrete", "different_structure": "unknown"}
LIST = {"non_ductile_concrete": "concrete", "soft_story": "soft_story"}
# One wave per night beat. Sizes scale with the apartments in the district (a real number, the horde is not).
WAVES = [{"n": 1, "sector": "W", "arrive_s": 20, "share": 0.04},
         {"n": 2, "sector": "N", "arrive_s": 45, "share": 0.07},
         {"n": 3, "sector": "E", "arrive_s": 70, "share": 0.11}]
SECTORS = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")
# On foot (contract v1.2): the buildings you can walk into (each has a cached 360-degree interior), and one Vexcel
# aerial mosaic under the playable area (fetched once into fixtures/vision, gitignored; the bounds are the box it was
# extracted for, in district metres).
ENTERABLE = ("6375735", "254167")
GROUND = {"image": "laststand_ground.jpg", "x0": -420, "z0": -220, "x1": 60, "z1": 60}


def _clamp(v: float, lo: int = 5, hi: int = 95) -> int:
    return int(max(lo, min(hi, round(v))))


def _xz(lat: float, lon: float, lat0: float, lon0: float) -> tuple[float, float]:
    """Metres east (x) and south (z) of the center: three.js looks down -z, so north is -z."""
    return round((lon - lon0) * K * math.cos(math.radians(lat0)), 1), round(-(lat - lat0) * K, 1)


def _simplify(pts: list[list[float]], tol: float = 0.75) -> list[list[float]]:
    """Douglas-Peucker on an open polyline (the ring's closing point is dropped first)."""
    if len(pts) < 3:
        return pts
    a, b = pts[0], pts[-1]
    dx, dy = b[0] - a[0], b[1] - a[1]
    norm = math.hypot(dx, dy) or 1e-9
    dists = [abs(dy * (p[0] - a[0]) - dx * (p[1] - a[1])) / norm for p in pts[1:-1]]
    i = max(range(len(dists)), key=dists.__getitem__)
    if dists[i] <= tol:
        return [a, b]
    return _simplify(pts[: i + 2], tol)[:-1] + _simplify(pts[i + 1:], tol)


def _aerial(pid: str) -> dict[str, Any] | None:
    """Cached Vexcel only: the game never fetches live data while someone is playing."""
    p = FIXTURES / "vexcel" / f"{pid}.json"
    return json.loads(p.read_text()) if p.exists() else None


def _footprint(pid: str, aer: dict[str, Any] | None, stories: int | None) -> list[list[float]] | None:
    """[[x, z], ...] metres relative to the building's own x, z (east, south), or None for a box."""
    if not aer or pid in NO_EXTRUDE or not aer.get("footprint_polygon_m"):
        return None
    fp, parcel, h = aer.get("footprint_sqft"), aer.get("parcel_area_sqft"), aer.get("height_m")
    if fp and parcel and fp > 1.25 * parcel:
        return None  # the outline likely includes a neighbor (layers._outline_problem)
    if h and stories and not 2.4 <= h / stories <= 6.5:
        return None  # the outline's height doesn't fit the record's floors: likely another structure
    ring = [[float(x), -float(y)] for x, y in aer["footprint_polygon_m"]]
    if ring[0] == ring[-1]:
        ring = ring[:-1]
    # A closed ring has identical ends, so split it at the vertex farthest from the start and simplify each half.
    far = max(range(len(ring)), key=lambda i: math.dist(ring[0], ring[i]))
    simple = _simplify(ring[: far + 1])[:-1] + _simplify(ring[far:] + [ring[0]])[:-1] if far else ring
    return [[round(x, 1), round(z, 1)] for x, z in (simple if len(simple) >= 3 else ring)]


def _label(rec: dict[str, Any]) -> str:
    return (rec.get("address") or rec["property_id"]).split(",")[0]


def _material(rec: dict[str, Any]) -> str:
    return MATERIAL.get(rec.get("construction_material") or "", "unknown")


@lru_cache(maxsize=1)
def _employees() -> dict[str, int]:
    """Employees CoStar records in each building (current tenancies). Counts only: never a company name."""
    from app import tenants

    out: dict[str, int] = collections.defaultdict(int)
    try:
        for (pid, _suite), recs in tenants._index()["current"].items():
            out[str(pid)] += sum(r.get("employees") or 0 for r in recs)
    except Exception:
        return {}
    return dict(out)


def _listed_suites(pid: str) -> int:
    from app import tenants

    try:
        return sum(1 for (p, _s) in tenants._index()["live"] if str(p) == pid)
    except Exception:
        return 0


def _city(rec: dict[str, Any]) -> dict[str, Any]:
    a = retrofit_lists.assess(rec)
    lists = a.get("lists") or []
    hyp = {h["key"]: h for h in a.get("hypotheses") or []}
    return {"list": LIST.get(lists[0]["list"]) if lists else None, "status": a.get("status"),
            "unfinished": a.get("status") == "unfinished", "past_due": bool((hyp.get("unfinished") or {}).get("past_due")),
            "next": next((s for s in (lists[0].get("steps") or []) if s.get("state") != "done"), None) if lists else None}


def _mmi(rec: dict[str, Any]) -> float | None:
    s = quake.shaking(rec["latitude"], rec["longitude"]) if rec.get("latitude") else None
    return s["mmi"] if s else None


# ------------------------------------------------------------------ the district


def _outline(b: dict[str, Any]) -> list[tuple[float, float]]:
    if b["footprint"]:
        return [(b["x"] + px, b["z"] + pz) for px, pz in b["footprint"]]
    hw, hd = b["w"] / 2, b["d"] / 2
    return [(b["x"] - hw, b["z"] - hd), (b["x"] + hw, b["z"] - hd), (b["x"] + hw, b["z"] + hd), (b["x"] - hw, b["z"] + hd)]


def _door(b: dict[str, Any], others: list[dict[str, Any]]) -> dict[str, Any]:
    """A door on the outline edge with the most open street in front of it (we don't know the real entrance).
    facing: the outward normal in degrees, 0 = north (-z), clockwise."""
    ring = _outline(b)
    cx, cz = sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)
    blockers = [(o["x"], o["z"], max(o["w"], o["d"]) / 2) for o in others if o["pid"] != b["pid"]]
    best = None
    for (ax, az), (bx, bz) in zip(ring, ring[1:] + ring[:1]):
        length = math.hypot(bx - ax, bz - az)
        if length < 4:
            continue
        mx, mz = (ax + bx) / 2, (az + bz) / 2
        nx, nz = (bz - az) / length, -(bx - ax) / length
        if (mx - cx) * nx + (mz - cz) * nz < 0:
            nx, nz = -nx, -nz  # point away from the building
        clear = next((d for d in range(5, 45, 5) if any(math.hypot(mx + nx * d - ox, mz + nz * d - oz) < r for ox, oz, r in blockers)), 45)
        if best is None or (clear, length) > best[0]:
            best = ((clear, length), mx + nx, mz + nz, nx, nz)
    if best is None:
        return {"x": b["x"], "z": b["z"], "facing": 0}
    _, x, z, nx, nz = best
    return {"x": round(x, 1), "z": round(z, 1), "facing": round(math.degrees(math.atan2(nx, -nz)) % 360)}


def _ground() -> dict[str, Any] | None:
    return dict(GROUND) if (VISION / GROUND["image"]).exists() else None


@lru_cache(maxsize=1)
def district() -> dict[str, Any]:
    c = costar.get(CENTER_PID)
    lat0, lon0 = c["latitude"], c["longitude"]
    buildings, units = [], 0
    for pid, rec in costar._index().items():
        if not rec.get("latitude") or rec.get("synthetic"):
            continue
        x, z = _xz(rec["latitude"], rec["longitude"], lat0, lon0)
        if math.hypot(x, z) > RADIUS_M:
            continue
        units += rec.get("units") or 0
        stories = rec.get("stories") or None
        aer = _aerial(pid)
        fp = _footprint(pid, aer, stories)
        floor = rec.get("typical_floor_sqft") or ((rec.get("gba_sqft") or 0) / (stories or 1)) or 6000
        side = round(max(12.0, min(80.0, math.sqrt(floor * 0.0929))), 1)
        height = aer.get("height_m") if fp and aer and aer.get("height_m") else (stories or 3) * FLOOR_M
        city = _city(rec)
        mat = _material(rec)
        conflict = {"costar": mat, "city": "concrete"} if city["list"] == "concrete" and mat not in ("concrete", "unknown") else None
        buildings.append({
            "pid": pid, "label": _label(rec), "x": x, "z": z, "footprint": fp, "w": side, "d": side,
            "height_m": round(height, 1), "stories": stories, "material": mat, "list": city["list"],
            "unfinished": city["unfinished"], "past_due": city["past_due"], "mmi": _mmi(rec), "hero": pid in HEROES,
            "year_built": rec.get("year_built"), "people": _employees().get(pid) or None, "conflict": conflict})
    buildings.sort(key=lambda b: (not b["hero"], b["pid"]))
    for b in buildings:
        b["door"] = _door(b, buildings) if b["pid"] in ENTERABLE else None
    waves = [{"n": w["n"], "sector": w["sector"], "arrive_s": w["arrive_s"], "size": max(50, round(units * w["share"] / 10) * 10)}
             for w in WAVES]
    return {"center": {"lat": round(lat0, 6), "lon": round(lon0, 6)}, "radius_m": RADIUS_M, "seed": SEED,
            "buildings": buildings, "waves": waves, "ground": _ground()}


def building(pid: str) -> dict[str, Any] | None:
    return next((b for b in district()["buildings"] if b["pid"] == str(pid)), None)


# ------------------------------------------------------------------ scores


def _case(pid: str) -> dict[str, Any] | None:
    cases = evidence.open_case(pid).get("cases") or []
    mc = next((c for c in cases if c["case"] == "material_conflict"), None)
    return mc or (cases[0] if cases else None)


def walls(pid: str, checks: list[str] | tuple[str, ...] = (), notes: list[dict] | None = None) -> dict[str, Any]:
    rec = costar.get(pid)
    mat = _material(rec)
    case = _case(pid)
    if not case or case["case"] != "material_conflict":
        return {"value": WALLS[mat], "label": "known", "why": f"CoStar records {mat}; no other source disagrees",
                "source": "CoStar"}
    w = evidence.weigh_case(pid, "material_conflict", list(checks), None, notes or [])
    post = w["posterior"]
    value = sum(p * WALLS[HYPOTHESIS_MATERIAL.get(h, mat)] for h, p in post.items())
    v = w["verdict"]
    odds = ", ".join(f"{HYPOTHESIS_MATERIAL.get(h, mat)} {p:.2f}" for h, p in sorted(post.items(), key=lambda kv: -kv[1]))
    why = (f"CoStar records {mat}; the city's list says concrete. A gamble: {odds}" if v["label"] == "unresolved"
           else f"CoStar records {mat}; the city's list says concrete. {v['label'].capitalize()} {HYPOTHESIS_MATERIAL.get(v['hypothesis'], mat)} "
                f"({v['confidence']:.2f}): {odds}")
    return {"value": _clamp(value), "label": v["label"], "why": why, "source": "CoStar + LA retrofit list + evidence",
            "posterior": post, "checks": w.get("checks_used", list(checks))}


def quake_score(pid: str) -> dict[str, Any]:
    rec = costar.get(pid)
    city, mmi, mat = _city(rec), _mmi(rec) or 7.0, _material(rec)
    if city["list"] and city["unfinished"]:
        risk = 75 if city["list"] == "concrete" else 70
        nxt = city["next"]
        when = f"; next step due {nxt['due'][:4]}" if nxt and nxt.get("due") else ""
        state = "past a deadline" if city["past_due"] else "on schedule"
        what = f"the city ordered a {'concrete' if city['list'] == 'concrete' else 'soft-story'} retrofit; not finished ({state}{when})"
    elif city["list"]:
        risk, what = 30, "the city's ordered retrofit is finished"
    else:
        risk = {"masonry": 60, "concrete": 45 if (rec.get("year_built") or 2000) < 1977 else 25, "steel": 25, "wood": 35}.get(mat, 50)
        what = f"not on a city retrofit list; {mat} building from {rec.get('year_built') or 'an unknown year'}"
    return {"value": _clamp(100 - risk * mmi / 8.0), "label": "known", "why": f"{what}; felt MMI {mmi} in the 1994 Northridge replay",
            "source": "LA retrofit lists + USGS ShakeMap"}


def _roof(pid: str) -> dict[str, Any]:
    aer = _aerial(pid)
    if not aer:
        return {"value": 50, "label": "unresolved", "why": "no aerial data cached for this building", "source": "none"}
    objs = aer.get("roof_objects") or {}
    sky = objs.get("skylight", 0)
    flat = (aer.get("roof_shape") or "") == "flat"
    bits = [f"{aer.get('roof_shape') or 'unknown'} roof"] + [f"{n} {k.replace('-', ' ')}{'s' if n != 1 else ''}" for k, n in objs.items() if n]
    why = ", ".join(bits) + (f" (skylights are ways in)" if sky else "") + f"; Vexcel, captured {(aer.get('capture_date') or '')[:7]}"
    return {"value": _clamp(60 + (10 if flat else 0) - min(24, 4 * sky)), "label": "known", "why": why, "source": "Vexcel"}


def _people(pid: str) -> dict[str, Any]:
    rec = costar.get(pid)
    emp, units, listed = _employees().get(pid, 0), rec.get("units") or 0, _listed_suites(pid)
    if units:
        return {"value": _clamp(20 + units / 3), "label": "known", "why": f"{units} apartments on record", "source": "CoStar"}
    why = f"about {emp} employees on record" if emp else "no tenants on record"
    if listed:
        why += f"; {listed} suite{'s' if listed != 1 else ''} listed for lease (maybe empty)"
    return {"value": _clamp(20 + emp / 4), "label": "known", "why": why, "source": "CoStar"}


def _space(pid: str) -> dict[str, Any]:
    rec = costar.get(pid)
    gba, stories = rec.get("gba_sqft") or 0, rec.get("stories")
    return {"value": _clamp(gba / 2500), "label": "known",
            "why": f"{stories or '?'} floors, about {round(gba, -3):,.0f} sq ft", "source": "CoStar"}


def _images(pid: str) -> dict[str, Any]:
    drone = [p.name for p in sorted(VISION.glob(f"{pid}_oblique_*.jpg"))] + \
            [p.name for p in [VISION / f"{pid}_ortho_latest.jpg"] if p.exists()]
    cctv = [p.name for p in sorted(VISION.glob(f"{pid}_s*_p*_f[1-4].jpg"))]
    pano = []
    p0 = sorted({p.name.rsplit("_p0_f", 1)[0] for p in VISION.glob(f"{pid}_s*_p0_f*.jpg")})
    if p0:
        for k in range(6):
            f = VISION / f"{p0[0]}_p0_f{k}.jpg"
            if f.exists():
                pano.append({"face": f"f{k}", "name": f.name})
    # Inside (v1.2): the building's own twin if cached (6375735's top-floor loft), else the suite tour's faces.
    inside = [{"face": f"f{k}", "name": f.name} for k in range(6) if (f := VISION / f"{pid}_twin_p0_f{k}.jpg").exists()]
    return {"drone": drone, "cctv": cctv, "pano": pano, "inside": inside or (pano if pid in ENTERABLE else [])}


@lru_cache(maxsize=128)
def _dossier(pid: str) -> str:
    rec = costar.get(pid)
    case = _case(pid)
    scores = {"walls": walls(pid), "quake": quake_score(pid), "roof": _roof(pid), "people": _people(pid), "space": _space(pid)}
    for s in scores.values():
        s.pop("posterior", None), s.pop("checks", None)
    unknowns = ["stairs and exits: not in the data", "supplies: not in the data"]
    if scores["walls"]["label"] != "known":
        unknowns.insert(0, "walls: CoStar and the city's list disagree on the material")
    if scores["roof"]["label"] == "unresolved":
        unknowns.append("roof: no aerial data cached")
    return json.dumps({
        "pid": pid, "label": _label(rec), "scores": scores, "unknowns": unknowns, "images": _images(pid),
        "case": {k: case[k] for k in ("case", "question")} | {"hypotheses": [{k: h[k] for k in ("key", "claim", "prior")} for h in case["hypotheses"]]}
        if case else None,
        "disclaimer": DISCLAIMER})


def dossier(pid: str) -> dict[str, Any]:
    """The fortress card. Raises costar.CoStarError for an unknown id. Images are listed fresh (cheap), so a
    newly cached picture shows up without a restart."""
    pid = str(pid).strip()
    return json.loads(_dossier(pid)) | {"images": _images(pid)}


# ------------------------------------------------------------------ the night


def horde_status(wave: int) -> dict[str, Any]:
    ws = district()["waves"]
    w = ws[max(0, min(len(ws) - 1, int(wave) - 1))]
    eta = "<30s" if w["arrive_s"] < 30 else "30-60s" if w["arrive_s"] <= 60 else ">60s"
    size = "small" if w["size"] < 300 else "large" if w["size"] < 600 else "huge"
    return {"wave": w["n"], "sector": w["sector"], "eta_band": eta, "size_band": size}


def _bearing(b: dict[str, Any], to: dict[str, Any]) -> str:
    ang = math.degrees(math.atan2(to["x"] - b["x"], -(to["z"] - b["z"]))) % 360  # 0 = north, clockwise
    return SECTORS[int((ang + 22.5) // 45) % 8]


def _opposite(s: str) -> set[str]:
    i = SECTORS.index(s)
    return {SECTORS[(i + 3) % 8], SECTORS[(i + 4) % 8], SECTORS[(i + 5) % 8]}


def find_fallback(pid: str, away_from: str | None = None) -> dict[str, Any]:
    """The strongest nearby building, preferring ones that lie away from the attack. Code ranks; no model."""
    here = building(pid)
    if not here:
        return {"from_pid": str(pid), "to_pid": None, "to_label": None, "distance_band": None, "reason": "not in the district"}
    best, best_score = None, -1e9
    for b in district()["buildings"]:
        if b["pid"] == here["pid"] or (b["stories"] or 0) < 4:
            continue
        dist = math.hypot(b["x"] - here["x"], b["z"] - here["z"])
        if dist > 600:
            continue
        d = dossier(b["pid"])["scores"]
        score = d["walls"]["value"] + d["quake"]["value"] - dist / 20
        score += 15 if (away_from and _bearing(here, b) in _opposite(away_from)) else 0
        score += 10 if dossier(b["pid"])["images"]["cctv"] else 0  # a scanned suite to hold
        if score > best_score:
            best, best_score = b, score
    if not best:
        return {"from_pid": here["pid"], "to_pid": None, "to_label": None, "distance_band": None, "reason": "nothing stronger within 600 m"}
    d = dossier(best["pid"])
    dist = math.hypot(best["x"] - here["x"], best["z"] - here["z"])
    reason = [f"walls {d['scores']['walls']['value']} ({d['scores']['walls']['why'].split(';')[0]})",
              f"quake {d['scores']['quake']['value']} ({d['scores']['quake']['why'].split(';')[0]})"]
    if d["images"]["cctv"]:
        reason.append("a scanned suite listed for lease: a room you can hold")
    if away_from:
        reason.append(f"it lies {_bearing(here, best)}, away from the horde in the {away_from}" if _bearing(here, best) in _opposite(away_from)
                      else f"it lies {_bearing(here, best)}")
    return {"from_pid": here["pid"], "to_pid": best["pid"], "to_label": best["label"],
            "distance_band": "<200 m" if dist < 200 else "200-500 m" if dist <= 500 else ">500 m", "reason": "; ".join(reason)}


def resolve(pid: str, wave: int, seed: int = SEED, action: str = "hold", to_pid: str | None = None,
            checks: list[str] | tuple[str, ...] = (), notes: list[dict] | None = None) -> dict[str, Any]:
    """The wave hits and an aftershock follows. Seeded rolls against code scores: same inputs, same night."""
    action = "run" if action == "run" and to_pid else "hold"
    final = str(to_pid) if action == "run" else str(pid)
    w = walls(final, checks if final == str(pid) else (), notes if final == str(pid) else None)
    q = quake_score(final)
    rng = random.Random(f"{seed}:{int(wave)}:{final}:{action}")
    walls_roll, quake_roll = rng.randint(1, 100), rng.randint(1, 100)
    on_foot = 10 if action == "run" else 0  # crossing the street costs you
    walls_need, quake_need = w["value"] - on_foot, min(95, q["value"] + 40)  # an aftershock is smaller than the main shock
    walls_ok, quake_ok = walls_roll <= walls_need, quake_roll <= quake_need
    held = walls_ok and quake_ok
    why = [f"walls {w['value']}{f' - {on_foot} on foot' if on_foot else ''} vs roll {walls_roll}: "
           + ("the walls held" if walls_ok else "the horde got in"),
           f"aftershock: quake {q['value']} + 40 vs roll {quake_roll}: " + ("the building rode it out" if quake_ok else "the building cracked")]
    return {"held": held, "walls": w["value"], "quake": q["value"], "walls_roll": walls_roll, "quake_roll": quake_roll,
            "why": "; ".join(why) + f". {DISCLAIMER}.", "pid_final": final}

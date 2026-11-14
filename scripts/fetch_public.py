"""Download the public data the seismic lens uses, once, into fixtures/public/ (then everything runs offline).

  python scripts/fetch_public.py            # fetch what's missing
  python scripts/fetch_public.py --refetch  # fetch everything again

Sources (all public, no key):
  LA soft-story retrofit list        data.lacity.org dqq4-799r
  LA non-ductile concrete list       data.lacity.org ke3z-xgni
  LA permits 2020+ (retrofit work)   data.lacity.org pi9x-tg5x, filtered to soft-story / non-ductile work
  1994 Northridge earthquake         USGS event ci3144585 and its ShakeMap grid (shaking intensity by location)

Nothing from the CoStar kit is sent anywhere: matching happens locally (app/retrofit_lists.py).
httpx verifies TLS with certifi (the system Python's certificates fail on data.lacity.org).
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import zipfile
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "fixtures" / "public"
UA = {"User-Agent": "retrofit-radar-hackathon (public data fetch)"}
SOCRATA = "https://data.lacity.org/resource/{id}.json"
PERMIT_WHERE = "upper(work_desc) like '%SOFT%STORY%' OR upper(work_desc) like '%NON-DUCTILE%' OR upper(work_desc) like '%NONDUCTILE%'"
EVENT = "ci3144585"


def _get(client: httpx.Client, url: str, **params) -> httpx.Response:
    r = client.get(url, params=params or None)
    r.raise_for_status()
    return r


def fetch(refetch: bool = False) -> dict[str, str]:
    OUT.mkdir(parents=True, exist_ok=True)
    done: dict[str, str] = {}
    with httpx.Client(headers=UA, timeout=120, follow_redirects=True) as c:
        def socrata(name: str, dataset: str, **params) -> None:
            path = OUT / f"{name}.json"
            if path.exists() and not refetch:
                done[name] = "cached"
                return
            rows = _get(c, SOCRATA.format(id=dataset), **{"$limit": 50000, **params}).json()
            path.write_text(json.dumps(rows))
            done[name] = f"{len(rows)} rows"

        socrata("softstory", "dqq4-799r")
        socrata("ndc", "ke3z-xgni")
        socrata("retrofit_permits", "pi9x-tg5x", **{"$where": PERMIT_WHERE})

        event_path = OUT / f"usgs_{EVENT}.json"
        if not event_path.exists() or refetch:
            ev = _get(c, "https://earthquake.usgs.gov/fdsnws/event/1/query", eventid=EVENT, format="geojson").json()
            event_path.write_text(json.dumps(ev))
            done["event"] = f"M{ev['properties']['mag']} {ev['properties']['place']}"
        else:
            ev = json.loads(event_path.read_text())
            done["event"] = "cached"

        grid_path = OUT / f"shakemap_{EVENT}_grid.xml"
        if not grid_path.exists() or refetch:
            sm = (ev["properties"].get("products") or {}).get("shakemap") or []
            if not sm:
                done["shakemap"] = "no ShakeMap product"
            else:
                contents = sm[0]["contents"]
                if "download/grid.xml" in contents:
                    grid_path.write_bytes(_get(c, contents["download/grid.xml"]["url"]).content)
                elif "download/grid.xml.zip" in contents:
                    z = zipfile.ZipFile(io.BytesIO(_get(c, contents["download/grid.xml.zip"]["url"]).content))
                    grid_path.write_bytes(z.read(next(n for n in z.namelist() if n.endswith("grid.xml"))))
                else:
                    done["shakemap"] = "no grid.xml in ShakeMap contents"
                if grid_path.exists():
                    done["shakemap"] = f"{grid_path.stat().st_size // 1024} KB grid"
        else:
            done["shakemap"] = "cached"
    return done


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--refetch", action="store_true")
    for k, v in fetch(p.parse_args().refetch).items():
        print(f"{k:18} {v}")
    sys.exit(0)

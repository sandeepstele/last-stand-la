"""Download three public layers for Bob's district, once, into fixtures/public/ (then everything runs offline).

  python scripts/fetch_county.py            # fetch what's missing
  python scripts/fetch_county.py --refetch  # fetch everything again

Each source is queried with ONE fixed rectangle around downtown LA (BOX below): nothing from the CoStar kit, no
property id and no address is ever sent. Buildings are matched to these layers locally (app/county.py).

  LA County Assessor parcels        public.gis.lacounty.gov LACounty_Parcel (year built, effective year, building
                                    area, use, design type per parcel)
  LARIAC building outlines          public.gis.lacounty.gov LARIAC_Buildings_2020 (roof height in feet; the service is
                                    2020, the survey imagery 2008)
  LA City active businesses         data.lacity.org 6rrh-rzua (address, industry code, start date; business names are
                                    not downloaded)
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "fixtures" / "public"
UA = {"User-Agent": "retrofit-radar-hackathon (public data fetch)"}
# west, south, east, north (WGS84): downtown LA, covering the game district (900 m around the play area's centre)
BOX = (-118.2650, 34.0360, -118.2400, 34.0530)
GIS = "https://public.gis.lacounty.gov/public/rest/services"
LAYERS = {
    "county_parcels.json": (f"{GIS}/LACounty_Cache/LACounty_Parcel/MapServer/0/query",
                            "AIN,UseType,UseDescription,DesignType1,YearBuilt1,EffectiveYear1,Units1,SQFTmain1,SQFTmain2,"
                            "SQFTmain3,SQFTmain4,SQFTmain5,YearBuilt2,YearBuilt3"),
    "lariac_buildings.json": (f"{GIS}/LACounty_Dynamic/LARIAC_Buildings_2020/MapServer/0/query",
                              "BLD_ID,HEIGHT,ELEV,AREA,SOURCE,DATE_,STATUS,CODE"),
}
BUSINESSES = "https://data.lacity.org/resource/6rrh-rzua.json"
BUSINESS_FIELDS = "street_address,zip_code,naics,primary_naics_description,location_start_date,location_end_date,location_1"


def _arcgis(client: httpx.Client, url: str, fields: str) -> list[dict]:
    w, s, e, n = BOX
    q = {"geometry": f"{w},{s},{e},{n}", "geometryType": "esriGeometryEnvelope", "inSR": 4326, "outSR": 4326,
         "spatialRel": "esriSpatialRelIntersects", "outFields": fields, "returnGeometry": "true", "f": "json"}
    out, offset = [], 0
    while True:
        r = client.get(url, params={**q, "resultOffset": offset, "resultRecordCount": 1000})
        r.raise_for_status()
        data = r.json()
        feats = data.get("features") or []
        out += [{"a": f.get("attributes") or {}, "rings": (f.get("geometry") or {}).get("rings") or []} for f in feats]
        if not feats or not data.get("exceededTransferLimit"):
            return out
        offset += len(feats)


def _businesses(client: httpx.Client) -> list[dict]:
    w, s, e, n = BOX
    where = f"within_box(location_1, {n}, {w}, {s}, {e}) AND location_end_date IS NULL"
    out, offset = [], 0
    while True:
        r = client.get(BUSINESSES, params={"$select": BUSINESS_FIELDS, "$where": where, "$limit": 5000, "$offset": offset})
        r.raise_for_status()
        rows = r.json()
        out += rows
        if len(rows) < 5000:
            return out
        offset += len(rows)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--refetch", action="store_true")
    a = p.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    with httpx.Client(headers=UA, timeout=60) as client:
        for name, (url, fields) in LAYERS.items():
            path = OUT / name
            if path.exists() and not a.refetch:
                print(f"have {name}")
                continue
            rows = _arcgis(client, url, fields)
            path.write_text(json.dumps({"box": BOX, "source": url.split("/rest/services/")[1], "features": rows}))
            print(f"wrote {name}: {len(rows)} features")
        path = OUT / "la_businesses.json"
        if path.exists() and not a.refetch:
            print("have la_businesses.json")
        else:
            rows = _businesses(client)
            path.write_text(json.dumps({"box": BOX, "source": "data.lacity.org 6rrh-rzua", "rows": rows}))
            print(f"wrote la_businesses.json: {len(rows)} active businesses (no names)")


if __name__ == "__main__":
    main()

"""Build the geo data the zip map reads.

Inputs (raw/):  Census 2020 cartographic boundary shapefiles: ZCTA 500k, place 500k, county 5m, state 5m.
Outputs (data/geo/):
  index.json        states list: abbr, name, fips, zcta count, bbox
  us.json           TopoJSON: states + counties (national context layer)
  {ST}.json         TopoJSON per state: layers `zcta` (zip polygons) and `place` (city outlines)
  {ST}-meta.json    per state: zip -> {city, county, lat, lng, drawable}; cities index (USPS names incl.
                    acceptable names) -> zips; places index (Census place names) -> zips by area overlap

Run:  uv run python build/geobuild.py            (all states, ~10 min)
      uv run python build/geobuild.py CO NC      (subset, for iteration)
"""
from __future__ import annotations

import json
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

import geopandas as gpd
import zipcodes

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw"
OUT = ROOT / "data" / "geo"
TMP = ROOT / "raw" / "tmp"
OUT.mkdir(parents=True, exist_ok=True)
TMP.mkdir(parents=True, exist_ok=True)

# A zip belongs to a place when the overlap is at least this share of the zip's area, or of the
# place's area (so a small town inside one big zip still claims that zip). Slivers are excluded.
MIN_SHARE = 0.10
EQUAL_AREA = "EPSG:5070"


def norm(name: str) -> str:
    return " ".join(name.lower().replace(".", "").split())


def main(only: list[str]) -> None:
    print("loading shapefiles ...")
    states = gpd.read_file(RAW / "cb_2020_us_state_5m.shp")[["STATEFP", "STUSPS", "NAME", "geometry"]]
    counties = gpd.read_file(RAW / "cb_2020_us_county_5m.shp")[["STATEFP", "GEOID", "NAME", "geometry"]]
    places = gpd.read_file(RAW / "cb_2020_us_place_500k.shp")[["STATEFP", "GEOID", "NAME", "LSAD", "geometry"]]
    zcta = gpd.read_file(RAW / "cb_2020_us_zcta520_500k.shp")[["ZCTA5CE20", "geometry"]].rename(columns={"ZCTA5CE20": "zip"})
    fips_to_abbr = dict(zip(states.STATEFP, states.STUSPS))
    print(f"  {len(zcta)} ZCTAs, {len(places)} places, {len(counties)} counties")

    # USPS meta: zip -> city/county/latlng and the city-name index. Independent of polygons.
    print("indexing USPS zips ...")
    usps = zipcodes.list_all()
    zip_state: dict[str, str] = {}
    meta_by_state: dict[str, dict] = defaultdict(dict)
    cities_by_state: dict[str, dict[str, set]] = defaultdict(lambda: defaultdict(set))
    for z in usps:
        st = z["state"]
        if st not in fips_to_abbr.values():
            continue
        zc = z["zip_code"]
        zip_state[zc] = st
        meta_by_state[st][zc] = {
            "city": z["city"].title(),
            "county": z.get("county", "") or "",
            "type": z.get("zip_code_type", ""),
            "lat": float(z["lat"]) if z.get("lat") else None,
            "lng": float(z["long"]) if z.get("long") else None,
            "drawable": False,
        }
        for name in [z["city"], *(z.get("acceptable_cities") or [])]:
            cities_by_state[st][norm(name)].add(zc)

    # Assign each ZCTA a state: USPS says so when it knows the zip; otherwise spatial.
    print("assigning ZCTAs to states ...")
    zcta["state"] = zcta["zip"].map(zip_state)
    missing = zcta[zcta.state.isna()]
    if len(missing):
        pts = missing.copy()
        pts["geometry"] = pts.representative_point()
        joined = gpd.sjoin(pts, states[["STATEFP", "geometry"]], how="left", predicate="within")
        zcta.loc[missing.index, "state"] = joined["STATEFP"].map(fips_to_abbr).values
    zcta = zcta.dropna(subset=["state"])
    places["state"] = places["STATEFP"].map(fips_to_abbr)

    # National context layer.
    print("writing us.json ...")
    states.to_file(TMP / "states.geojson", driver="GeoJSON")
    counties.assign(state=counties.STATEFP.map(fips_to_abbr)).to_file(TMP / "counties.geojson", driver="GeoJSON")
    mapshaper(
        ["-i", str(TMP / "states.geojson"), str(TMP / "counties.geojson"), "combine-files",
         "-simplify", "30%", "keep-shapes", "-o", str(OUT / "us.json"), "format=topojson", "precision=0.001"]
    )

    index = []
    targets = [s for s in sorted(states.STUSPS) if not only or s in only]
    for st in targets:
        z = zcta[zcta.state == st]
        if z.empty:
            continue
        p = places[places.state == st]
        print(f"{st}: {len(z)} zips, {len(p)} places")

        # Which USPS zips have a polygon.
        meta = meta_by_state[st]
        for zc in z.zip:
            meta.setdefault(zc, {"city": "", "county": "", "type": "ZCTA", "lat": None, "lng": None})["drawable"] = True

        # Place -> zips by area overlap, computed in an equal-area projection.
        zp = z.to_crs(EQUAL_AREA)
        pp = p.to_crs(EQUAL_AREA)
        zp["zip_area"] = zp.area
        pp["place_area"] = pp.area
        pairs = gpd.sjoin(pp, zp[["zip", "zip_area", "geometry"]], how="inner", predicate="intersects")
        places_idx: dict[str, dict] = {}
        if len(pairs):
            zgeom = zp.set_index("zip").geometry
            inter = pairs.geometry.intersection(gpd.GeoSeries(zgeom.loc[pairs.zip].values, crs=EQUAL_AREA, index=pairs.index))
            pairs["share_zip"] = inter.area / pairs.zip_area
            pairs["share_place"] = inter.area / pairs.place_area
            keep = pairs[(pairs.share_zip >= MIN_SHARE) | (pairs.share_place >= MIN_SHARE)]
            for geoid, grp in keep.groupby("GEOID"):
                row = grp.iloc[0]
                places_idx[norm(row.NAME)] = {"name": row.NAME, "geoid": geoid, "lsad": row.LSAD,
                                              "zips": sorted(grp.zip.tolist())}

        # Per-state TopoJSON: zips + place outlines.
        z[["zip", "geometry"]].to_file(TMP / "zcta.geojson", driver="GeoJSON")
        p[["GEOID", "NAME", "geometry"]].rename(columns={"GEOID": "geoid", "NAME": "name"}).to_file(TMP / "place.geojson", driver="GeoJSON")
        mapshaper(
            ["-i", str(TMP / "zcta.geojson"), str(TMP / "place.geojson"), "combine-files",
             "-simplify", "15%", "keep-shapes", "-o", str(OUT / f"{st}.json"), "format=topojson", "precision=0.0001"]
        )
        (OUT / f"{st}-meta.json").write_text(json.dumps({
            "state": st,
            "zips": meta,
            "cities": {k: sorted(v) for k, v in cities_by_state[st].items()},
            "places": places_idx,
        }, separators=(",", ":")))

        b = z.total_bounds
        index.append({"abbr": st, "name": states.loc[states.STUSPS == st, "NAME"].iloc[0],
                      "fips": states.loc[states.STUSPS == st, "STATEFP"].iloc[0],
                      "zips": int(len(z)), "prefixes": dict(sorted(Counter(zc[:3] for zc in meta).items())), "bbox": [round(float(x), 3) for x in b]})

    # Merge into an existing index when building a subset.
    idx_path = OUT / "index.json"
    existing = {s["abbr"]: s for s in json.loads(idx_path.read_text())["states"]} if idx_path.exists() else {}
    existing.update({s["abbr"]: s for s in index})
    idx_path.write_text(json.dumps({"states": sorted(existing.values(), key=lambda s: s["abbr"]),
                                    "source": "Census 2020 cartographic boundaries (ZCTA 500k, place 500k, county/state 5m); USPS names via `zipcodes`"}, indent=1))
    print("done:", OUT)


def mapshaper(args: list[str]) -> None:
    subprocess.run(["npx", "mapshaper", *args], check=True, cwd=ROOT, capture_output=True)


if __name__ == "__main__":
    main([a.upper() for a in sys.argv[1:]])

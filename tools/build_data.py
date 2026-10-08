#!/usr/bin/env python3
"""Build every static data file the site needs into public/data/.

Run once a year (OFLC publishes new wages each July), then commit public/data/:

    python tools/build_data.py                 # current wage year below
    python tools/build_data.py --year 2027-28  # next year

Inputs (downloaded into raw/, which is git-ignored):
  * OFLC wage zip   https://flag.dol.gov/sites/default/files/wages/OFLC_Wages_<year>.zip
  * Census cartographic boundaries (county + state, 1:500k)
Needs: pip install pyshp
"""
import argparse, csv, unicodedata, json, math, shutil, statistics, sys, urllib.request, zipfile
from datetime import date
from pathlib import Path

import shapefile  # pyshp

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw"
OUT = ROOT / "public" / "data"
CENSUS = "https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_{}_500k.zip"
WAGES = "https://flag.dol.gov/sites/default/files/wages/OFLC_Wages_{}.zip"

# STATEFP of the 50 states + DC (territories are not drawn)
STATES = {
    "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC",
    "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
    "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT",
    "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
    "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT",
    "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY",
}
FLAG = {"": 0, "Annual Wage": 1, "High Wage": 2, "No Leveled Wage": 3}  # see README "Data notes"


def fold(s):
    """Doña -> dona: the OFLC and Census files disagree on accents."""
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()


def fetch(url, dest):
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print("downloading", url)
    req = urllib.request.Request(url, headers={"User-Agent": "wage-map-build/1.0"})
    with urllib.request.urlopen(req) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)
    return dest


def unzip(zpath):
    d = zpath.with_suffix("")
    if not d.exists():
        with zipfile.ZipFile(zpath) as z:
            z.extractall(d)
    return d


# ---------- projections (all return SVG-style x, y with y pointing down) ----------
class Albers:
    def __init__(self, lat1, lat2, lat0, lon0):
        r = math.radians
        self.n = (math.sin(r(lat1)) + math.sin(r(lat2))) / 2
        self.C = math.cos(r(lat1)) ** 2 + 2 * self.n * math.sin(r(lat1))
        self.rho0 = math.sqrt(self.C - 2 * self.n * math.sin(r(lat0))) / self.n
        self.lon0 = lon0

    def __call__(self, lon, lat):
        r = math.radians
        if lon - self.lon0 > 180:
            lon -= 360
        if lon - self.lon0 < -180:
            lon += 360
        rho = math.sqrt(self.C - 2 * self.n * math.sin(r(lat))) / self.n
        t = self.n * r(lon - self.lon0)
        return rho * math.sin(t), self.rho0 - rho * math.cos(t)


def rings_of(shape):
    pts, parts = shape.points, list(shape.parts) + [len(shape.points)]
    return [pts[parts[i]:parts[i + 1]] for i in range(len(parts) - 1)]


def fmt(v):
    s = f"{v:.1f}"
    return s[:-2] if s.endswith(".0") else s


def to_path(rings, tol):
    """rings: lists of (x, y) already in output pixels. Drops points closer than tol to the last kept one."""
    out = []
    for ring in rings:
        kept = []
        for x, y in ring:
            if not kept or abs(x - kept[-1][0]) + abs(y - kept[-1][1]) >= tol:
                kept.append((x, y))
        if len(kept) < 4:
            continue
        out.append("M" + "L".join(f"{fmt(x)} {fmt(y)}" for x, y in kept) + "Z")
    return "".join(out)


def bbox(rings_list):
    xs = [x for rings in rings_list for ring in rings for x, _ in ring]
    ys = [y for rings in rings_list for ring in rings for _, y in ring]
    return min(xs), min(ys), max(xs), max(ys)


def transform(rings, sx, ox, oy):
    return [[((x * sx) + ox, (y * sx) + oy) for x, y in ring] for ring in rings]


def label_point(rings):
    """[x, y, width] of the largest ring's bounding box, used to place the state abbreviation."""
    best = max(rings, key=lambda r: (max(x for x, _ in r) - min(x for x, _ in r)) * (max(y for _, y in r) - min(y for _, y in r)))
    x0, y0, x1, y1 = bbox([[best]])
    return [round((x0 + x1) / 2), round((y0 + y1) / 2), round(x1 - x0)]


def read_shp(folder):
    sf = shapefile.Reader(str(next(folder.glob("*.shp"))))
    names = [f[0] for f in sf.fields[1:]]
    for sr in sf.iterShapeRecords():
        yield dict(zip(names, sr.record)), sr.shape


# ---------- geography ----------
def build_geo(counties_dir, states_dir):
    geo = OUT / "geo"
    (geo / "counties").mkdir(parents=True, exist_ok=True)

    # national view: Albers USA style composite (lower 48 + Alaska and Hawaii insets)
    proj = {
        "main": Albers(29.5, 45.5, 37.5, -96),
        "02": Albers(55, 65, 50, -154),
        "15": Albers(8, 18, 3, -157),
    }
    states = []
    for rec, shp in read_shp(states_dir):
        if rec["STATEFP"] not in STATES:
            continue
        fp = rec["STATEFP"]
        p = proj.get(fp, proj["main"])
        rings = [[(lambda a: (a[0], -a[1]))(p(lon, lat)) for lon, lat in ring] for ring in rings_of(shp)]
        states.append({"id": fp, "ab": STATES[fp], "name": rec["NAME"], "rings": rings})
    main = [s["rings"] for s in states if s["id"] not in ("02", "15")]
    x0, y0, x1, y1 = bbox(main)
    scale = 1000 / (x1 - x0)
    for s in states:
        sc = scale * {"02": 0.35, "15": 1.0}.get(s["id"], 1.0)
        s["rings"] = transform(s["rings"], sc, 0, 0)
    x0, y0, x1, y1 = bbox([s["rings"] for s in states if s["id"] not in ("02", "15")])
    # insets sit in the empty space below the Southwest
    for fp, left, bottom in (("02", x0 + 10, y1 + 5), ("15", x0 + 245, y1 + 5)):
        grp = [s for s in states if s["id"] == fp][0]
        gx0, gy0, gx1, gy1 = bbox([grp["rings"]])
        grp["rings"] = transform(grp["rings"], 1, left - gx0, bottom - gy1)
    allx0, ally0, allx1, ally1 = bbox([s["rings"] for s in states])
    for s in states:
        s["rings"] = transform(s["rings"], 1, -allx0, -ally0)
    W, H = allx1 - allx0, ally1 - ally0
    out = {"w": round(W), "h": round(H),
           "states": [{"id": s["id"], "ab": s["ab"], "name": s["name"], "d": to_path(s["rings"], 1.0),
                       "c": label_point(s["rings"])}
                      for s in sorted(states, key=lambda s: s["name"])]}
    (geo / "states.json").write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print("states.json", len(json.dumps(out)) // 1024, "KB")

    # one file per state with its counties, projected to fill a 1000px-wide box
    by_state = {}
    for rec, shp in read_shp(counties_dir):
        if rec["STATEFP"] in STATES:
            by_state.setdefault(rec["STATEFP"], []).append((rec, shp))
    index = {}
    for fp, items in by_state.items():
        lons, lats = [], []
        for _, shp in items:
            for lon, lat in shp.points:
                lons.append(lon - 360 if fp == "02" and lon > 0 else lon)
                lats.append(lat)
        lo, hi = min(lats), max(lats)
        p = Albers(lo + (hi - lo) / 6, hi - (hi - lo) / 6, (lo + hi) / 2, (min(lons) + max(lons)) / 2)
        cs = [(rec, [[(lambda a: (a[0], -a[1]))(p(lon, lat)) for lon, lat in ring] for ring in rings_of(shp)])
              for rec, shp in items]
        x0, y0, x1, y1 = bbox([c[1] for c in cs])
        sc = 1000 / (x1 - x0)
        H = (y1 - y0) * sc
        counties = []
        for rec, rings in sorted(cs, key=lambda c: c[0]["NAMELSAD"]):
            rr = transform(rings, sc, -x0 * sc, -y0 * sc)
            counties.append({"id": rec["GEOID"], "name": rec["NAMELSAD"], "d": to_path(rr, 0.5)})
        (geo / "counties" / f"{STATES[fp]}.json").write_text(
            json.dumps({"w": 1000, "h": round(H), "counties": counties}, separators=(",", ":")), encoding="utf-8")
        index[fp] = {fold(n["name"]): n["id"] for n in counties}
    sizes = sum(f.stat().st_size for f in (geo / "counties").glob("*.json"))
    print("counties/*.json", sizes // 1024, "KB total")
    return index  # statefp -> {NAMELSAD: GEOID}


# ---------- employment (BLS OEWS) ----------
def num_or_none(v, cast):
    try:
        return cast(v)
    except (TypeError, ValueError):   # BLS prints "**" for suppressed cells and "#" for top-coded ones
        return None


def load_employment():
    """soc -> {"nat": national employment, "areas": {area: [employment, location quotient]}}.

    Source: BLS OEWS "all data" workbook (manual download, the BLS site rejects scripts):
      https://www.bls.gov/oes/tables.htm  ->  May <year>, "All data"  ->  raw/oesm25all.zip
    Parsing the 78 MB workbook takes a few minutes, so the filtered rows are cached in raw/oews_emp.csv.
    """
    cache = RAW / "oews_emp.csv"
    if not cache.exists():
        z = RAW / "oesm25all.zip"
        if not z.exists():
            print("no", z.name, "- skipping employment data")
            return {}
        import openpyxl
        d = unzip(z)
        book = next(d.rglob("all_data_M_*.xlsx"))
        print("reading", book.name, "(a few minutes)")
        wb = openpyxl.load_workbook(book, read_only=True)
        ws = wb[wb.sheetnames[0]]
        rows = ws.iter_rows(values_only=True)
        head = list(next(rows))
        ix = {k: head.index(k) for k in ("AREA", "AREA_TYPE", "PRIM_STATE", "I_GROUP", "O_GROUP", "OCC_CODE", "TOT_EMP", "LOC_QUOTIENT")}
        with open(cache, "w", encoding="utf-8", newline="") as f:
            w = csv.writer(f)
            w.writerow(["area", "type", "state", "soc", "emp", "lq"])
            for r in rows:
                if r[ix["O_GROUP"]] != "detailed" or r[ix["I_GROUP"]] != "cross-industry":
                    continue
                if str(r[ix["AREA_TYPE"]]) not in ("1", "2", "4", "6"):   # national, state, metro, nonmetro
                    continue
                w.writerow([r[ix["AREA"]], r[ix["AREA_TYPE"]], r[ix["PRIM_STATE"]], r[ix["OCC_CODE"]], r[ix["TOT_EMP"]], r[ix["LOC_QUOTIENT"]]])
        wb.close()
    out = {}
    with open(cache, encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            e = num_or_none(r["emp"], lambda x: int(float(x)))
            q = num_or_none(r["lq"], float)
            o = out.setdefault(r["soc"], {"nat": None, "areas": {}, "states": {}})
            v = [e, None if q is None else round(q, 2)]
            if r["area"] == "99":
                o["nat"] = e
            elif r["type"] == "2":
                o["states"][r["state"]] = v
            else:
                o["areas"][r["area"].lstrip("0")] = v   # OEWS pads nonmetro codes ("0100001"), OFLC does not
    return out


# ---------- wages ----------
def num(s):
    return round(float(s), 2) if s not in ("", None) else None


def build_wages(wdir, name_index, emp):
    wages = OUT / "wages"
    if wages.exists():
        shutil.rmtree(wages)
    wages.mkdir(parents=True)

    titles = {}
    with open(wdir / "oes_soc_occs.csv", encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            titles[r["soccode"]] = (r["Title"], r["Description"])

    ab_to_fp = {v: k for k, v in STATES.items()}
    area_names, county_area, unmatched = {}, {}, []
    with open(wdir / "Geography.csv", encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            area_names[r["Area"]] = r["AreaName"]
            fp = ab_to_fp.get(r["StateAb"])
            if not fp:
                continue  # territories
            gid = name_index[fp].get(fold(r["CountyTownName"]))
            if gid:
                county_area[gid] = r["Area"]
            else:
                unmatched.append((r["StateAb"], r["CountyTownName"], r["AreaName"]))
    missing = [(ab, n) for fp, idx in name_index.items() for n, g in idx.items()
               if g not in county_area for ab in [STATES[fp]]]
    print("Geography rows with no matching Census county:", len(unmatched))
    for u in unmatched[:40]:
        print("   ", u)
    print("Census counties with no wage area:", len(missing))
    for m in missing[:40]:
        print("   ", m)

    per_soc = {}
    with open(wdir / "ALC_Export.csv", encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            row = [num(r["Level1"]), num(r["Level2"]), num(r["Level3"]), num(r["Level4"]),
                   int(r["GeoLvl"]), FLAG[r["Label"]]]
            if row[5] == 3:
                row.append(num(r["Average"]))
            per_soc.setdefault(r["SocCode"], {})[r["Area"]] = row
    socs = []
    for soc, areas in sorted(per_soc.items()):
        title, desc = titles.get(soc, (soc, ""))
        socs.append([soc, title])
        e = emp.get(soc, {"nat": None, "areas": {}, "states": {}})
        (wages / f"{soc}.json").write_text(
            json.dumps({"soc": soc, "title": title, "desc": desc, "areas": areas,
                        "nat": e["nat"], "states": e["states"], "emp": {a: v for a, v in e["areas"].items() if a in areas}},
                       separators=(",", ":")), encoding="utf-8")
    print("wage files:", len(socs), "occupations,", sum(f.stat().st_size for f in wages.glob("*.json")) // 1024, "KB")

    used = {a for a in county_area.values()}
    (OUT / "occupations.json").write_text(json.dumps(socs, separators=(",", ":")), encoding="utf-8")
    (OUT / "areas.json").write_text(json.dumps({a: area_names[a] for a in sorted(used)}, separators=(",", ":")), encoding="utf-8")
    (OUT / "county-area.json").write_text(json.dumps(county_area, separators=(",", ":")), encoding="utf-8")
    return len(socs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", default="2026-27")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    wdir = unzip(fetch(WAGES.format(a.year), RAW / f"OFLC_Wages_{a.year}.zip"))
    cdir = unzip(fetch(CENSUS.format("county"), RAW / "cb_2023_us_county_500k.zip"))
    sdir = unzip(fetch(CENSUS.format("state"), RAW / "cb_2023_us_state_500k.zip"))
    idx = build_geo(cdir, sdir)
    n = build_wages(wdir, idx, load_employment())
    start, end = a.year.split("-")
    (OUT / "meta.json").write_text(json.dumps({
        "wageYear": f"July {start} to June 20{end}", "occupations": n,
        "built": date.today().isoformat()}, separators=(",", ":")), encoding="utf-8")
    print("done")


if __name__ == "__main__":
    sys.exit(main())

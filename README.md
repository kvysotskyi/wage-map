# Wage Level Map

Static site showing DOL OFLC prevailing wage Levels I to IV (H-1B / PERM) for every occupation,
as a US map by state, then by county. No backend and no build step on Netlify.

## Layout

```
public/index.html          page shell
public/static/             style.css, app.js (vanilla JS, no dependencies)
public/data/               GENERATED, committed. Do not edit by hand
  occupations.json         [[soc, title], ...] for the search box
  areas.json               OES area code -> name
  county-area.json         county FIPS -> OES area code
  meta.json                wage year label
  wages/<SOC>.json         one file per occupation: {areas: {areaCode: [L1,L2,L3,L4,geoLvl,flag]}}
  geo/states.json          US map (Albers USA style, AK/HI insets) + label points
  geo/counties/<ST>.json   county outlines, one file per state
tools/build_data.py        raw OFLC + Census files -> public/data
raw/                       downloads cache (git-ignored)
netlify.toml               publish = public, security + cache headers
```

The page loads only `occupations`, `areas`, `county-area`, `meta`, `states.json` up front, then one
`wages/<SOC>.json` and one `counties/<ST>.json` as the user picks an occupation or state.

## Jobs data (BLS OEWS)

Each `wages/<SOC>.json` also holds employment: `emp` (per wage area: `[jobs, location quotient]`),
`states` (same, per state) and `nat` (national jobs). Source: BLS OEWS May 2025 "all data" workbook.
The BLS site rejects scripts, so download it by hand from https://www.bls.gov/oes/tables.htm
(May 2025, "All data") and save it as `raw/oesm25all.zip`. The first build parses the 78 MB workbook
(a few minutes) and caches the filtered rows in `raw/oews_emp.csv`. Without the zip the build skips jobs data.
The second number in each pair is the BLS location quotient (1.0 = national share). The UI does not show it; the data is kept in case it is wanted later. `null` = suppressed by BLS.

## Update each July (new wage year)

```bash
pip install pyshp
python tools/build_data.py --year 2027-28
python -m http.server 8090 --directory public   # preview
```

Commit `public/data/` and push. Netlify publishes `public/` as is.

## Netlify setup (once)

New site from the git repo. `netlify.toml` already sets publish dir `public` and no build command.
Turn off deploy previews and branch deploys if you want to save credits.

## Data notes

* Wage rows: `[L1, L2, L3, L4, geoLvl, flag(, average)]`. Hourly dollars unless flag = 1.
* `flag` 0 normal, 1 "Annual Wage" (levels are annual dollars), 2 "High Wage" (levels blank; OFLC issues
  $115/h = $239,200), 3 "No Leveled Wage" (levels blank, shown as no data).
* `geoLvl` says where the wage came from: 1 area (MSA / non-MSA) data, 2 state data, 3 state data of a
  multi-state area's first principal city, 4 national data. Order follows OFLC's technical release notes;
  the labels for 3 and 4 are my reading, not an official legend.
* The state colour on the US map is the median of its counties' wages, not an official state wage.
* Territories (PR, GU, VI, ...) are in the OFLC files but not drawn.
* Unofficial reference. Confirm the wage on flag.dol.gov before filing.

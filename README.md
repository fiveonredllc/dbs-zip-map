# Buyer zip coverage map

Shows where DBS has buyers, how many overlap, and where prospects would add coverage. One page, no
backend, no runtime cost. Reads a Google Sheet that account owners keep current.

```
Google Sheet (tab per buyer, column per vertical)
   └─► web/data.js    validates every cell · expands "City, ST" to zips · reports issues
         └─► web/zipmap.js   heat map by distinct active buyers per zip · prospects hatched · filters
               └─► data/geo/  Census zip polygons per state + USPS/Census city indexes (built once)
```

## Run it

```bash
cd distribution/zip-map && uv run python build/serve.py
```

Open http://127.0.0.1:8766/web/ . The `zipmap` entry in `.claude/launch.json` does the same thing.

Mock mode (`?source=mock`, or `source: 'mock'` in `web/config.js`) reads CSV tabs from `data/mock/`,
which `build/mockdata.py` generates. That folder and `data/source/` stay local and are not in the repo.

Live site: https://app.databridgestudio.com (GitHub Pages from this repo; every push to `main` deploys).

## Point it at the real sheet

The sheet is **DBS Buyer Zips** (id in `web/config.js`), shared inside the databridgestudio.com
Workspace only. The page reads it with the viewer's own Google access (`source: 'google'`): the
viewer clicks "Sign in with Google" once per browser session, and the Sheets API returns the tabs.
Only the public OAuth client id lives in the page; no secrets, no server.

One-time setup (Google Cloud console, any DBS admin account, about ten minutes):

1. console.cloud.google.com → create a project (for example "DBS Tools").
2. APIs & Services → Library → enable **Google Sheets API**.
3. APIs & Services → OAuth consent screen → User type **Internal** (Workspace only; no verification
   needed). App name "DBS Buyer Zip Map", support email, save. Scopes: add
   `.../auth/spreadsheets.readonly`.
4. APIs & Services → Credentials → Create credentials → **OAuth client ID** → Web application.
   Authorized JavaScript origins: `http://localhost:8766` (and later the PWA's https origin).
   No redirect URIs needed.
5. Copy the client id (ends in `.apps.googleusercontent.com`) into `clientId` in `web/config.js`,
   or try it without editing: `web/index.html?client=<id>`.

The viewer's Google account must be able to open the sheet; otherwise the page says so. Sign-in
lasts about an hour, then "Reload data" asks again.

Fallbacks: `?source=mock` reads the local CSV tabs. `source: 'sheet'` reads a sheet shared as
"Anyone with the link" through Google's CSV export with no sign-in, which the DBS Workspace policy
does not allow for this sheet.

## Sheet contract

| Tab | Columns | Rules |
|---|---|---|
| `_buyers` | `buyer`, `status`, `notes` | One row per buyer. `status` is `active`, `prospect` or `paused`. The buyer name must match its tab name exactly. |
| `_verticals` | `vertical`, `notes`, optional `color` | One row per vertical. Column headers on buyer tabs must match these (case and spacing ignored). Each vertical gets its own map color in tab order; put a CSS color such as `#2e9e6b` in `color` to pin one. |
| one tab per buyer | row 1 = vertical names | Every cell below the header is one coverage item: a 5-digit zip (ZIP+4 accepted) or `City, ST`. Column lengths can differ. |

How values are read:

- **Zips** are checked against USPS. A zip with no map area (PO box, unique) is counted but not drawn and
  shows as a warning.
- **Cities** expand to every standard zip that USPS lists under that name (including USPS "acceptable"
  names, so `Highlands Ranch, CO` works even though USPS files it under Littleton) plus every zip whose
  area overlaps the Census city boundary by at least 10%. Unknown cities are errors.
- **Statuses**: `active` buyers make the heat. `prospect` buyers draw the orange hatch and never count
  toward heat. `paused` buyers are listed but ignored.
- **Leading zeros**: format zip columns as plain text in Sheets, or `02134` becomes `2134` and the page
  flags it.
- Every problem lands in the **data issues** alert. Three levels:
  - **error**: wrong format, unknown state, unknown city, or a header not in `_verticals`. Left off
    the map; fix the cell.
  - **warning**: a well-formed zip that none of our references know (the USPS-derived `zipcodes`
    package, Census ZCTAs, GeoNames). Almost always an unassigned, PO-box-only or single-building
    zip; Google still resolves these to a city from the prefix. Counted, not drawn. Nothing to fix
    unless the buyer meant a different zip.
  - **note**: a real PO box or unique zip with no map area. Counted, not drawn. Summarized per tab.

## Reading the map

- Fill hue = the vertical covering that zip. Shade = how many distinct active buyers cover it (1, 2, 3+).
  A zip covered under two or more of the selected verticals is grey, shaded the same way. No fill = no
  coverage. A buyer counts once per zip no matter how many of the selected verticals they cover there.
- One active buyer selected = flat blue, since overlap means nothing for one buyer.
- Orange hatch = at least one prospect targets the zip. "Prospect-only zips" counts the ones no
  active buyer has, which is the coverage a prospect would add.
- Zoom in for county lines, then city outlines and names, then zip numbers. Hover for the buyer list,
  click to pin it.

## Rebuild the geo data

Only needed when Census boundaries change (they publish yearly) or the thresholds change.

```bash
cd distribution/zip-map && uv sync && npm install
uv run python build/geobuild.py          # all states, ~8 min
uv run python build/geobuild.py CO NC    # a subset
uv run python build/mockdata.py          # regenerate the mock workbook + CSVs
```

Inputs are the Census 2020 cartographic boundary files in `raw/` (ZCTA 500k, place 500k, county and
state 5m). Outputs land in `data/geo/`: `us.json` (states + counties), `{ST}.json` (zip + city
polygons, TopoJSON) and `{ST}-meta.json` (zip → city/county, city → zips, Census place → zips). About
30 MB for all states; a page load fetches only the states that appear in the sheet.

## Plugging into the PWA

`web/zipmap.js` exports `mountZipMap(containerElement, config)` and returns `{ reload, destroy }`. It
needs `d3` and `topojson` as globals (vendored in `web/vendor/`) and the CSS in `web/style.css`, which is
scoped under `.zm` and themed with CSS variables including a dark variant. Nothing touches `window`
beyond those two libraries.

## Known limits

- Zip areas are Census ZCTAs, which track USPS zips closely but not perfectly. About one in five USPS
  zips (PO boxes, single buildings) has no area and cannot be drawn.
- City expansion is deliberately generous (USPS names plus 10% boundary overlap). For a prospect whose
  real list turns out narrower, enter their zips instead of the city.
- Google's CSV export is rate-limited for very frequent reloads. Normal use is fine.

"""Generate the mock "Buyer Zips" workbook and the CSV tabs the page reads in mock mode.

The workbook is the go-by for the real Google Sheet. Same tabs, same headers. Values are either a
5-digit zip or "City, ST"; the page expands cities to zips. Two bad cells are planted on purpose
(a 4-digit zip and an unknown city) so the data-issues panel has something to show.

Run:  uv run python build/mockdata.py      (needs data/geo/{ST}-meta.json for CO NC SC FL VA MD)
"""
from __future__ import annotations

import csv
import json
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill

ROOT = Path(__file__).resolve().parent.parent
GEO = ROOT / "data" / "geo"
MOCK = ROOT / "data" / "mock"
MOCK.mkdir(parents=True, exist_ok=True)


def meta(st: str) -> dict:
    return json.loads((GEO / f"{st}-meta.json").read_text())


def real_list(name: str) -> list[str]:
    """A buyer's real roofing zip list, copied from the file they sent (data/source/). Kept as-is,
    including any bad rows, so the page's validation shows what it would flag."""
    with (ROOT / "data" / "source" / name).open() as f:
        return [r[0].strip() for r in csv.reader(f) if r and r[0].strip()][1:]


def zips_in(st: str, counties: list[str], step: int = 1) -> list[str]:
    cs = {c.lower() for c in counties}
    m = meta(st)
    out = sorted(z for z, v in m["zips"].items()
                 if v["drawable"] and v["county"].lower().replace(" county", "") in cs)
    return out[::step]


DENVER_METRO = ["Denver", "Jefferson", "Arapahoe", "Adams", "Douglas", "Broomfield"]
FRONT_RANGE = DENVER_METRO + ["Boulder", "El Paso", "Larimer", "Weld"]

BUYERS = [
    ("Cyclopps", "active", "Roofing = real list sent Sept 18 (6,133 zips). HVAC/Gutters are mock."),
    ("LeadGIANT", "active", "Roofing = real list sent Sept 18 (7,219 zips). Gutters is mock."),
    ("Front Range Exteriors", "active", "Mock buyer to show overlap. Has two bad cells on purpose."),
    ("Peak Roofing Co", "prospect", "Website lists cities only. Targeting west + south Denver suburbs."),
    ("Summit HVAC", "prospect", "Northern Colorado HVAC prospect."),
    ("Old Buyer", "paused", "Paused buyers are kept for the record but never counted."),
]
VERTICALS = [("Roofing", ""), ("HVAC", ""), ("Gutters", "Live at DBS."), ("Solar", "Roadmap."), ("Windows", "Roadmap."), ("Siding", "Roadmap.")]

TABS: dict[str, dict[str, list[str]]] = {
    "Cyclopps": {
        "Roofing": real_list("cyclopps-roofing.csv"),
        "HVAC": zips_in("CO", DENVER_METRO, step=2),
        "Gutters": zips_in("CO", DENVER_METRO),
    },
    "LeadGIANT": {
        "Roofing": real_list("leadgiant-roofing.csv"),
        "Gutters": ["Charlotte, NC", "Charleston, SC", "Mount Pleasant, SC", *zips_in("FL", ["Hillsborough", "Pinellas"])],
    },
    "Front Range Exteriors": {
        "Roofing": [*zips_in("CO", ["Jefferson"]), "8000", "Nowhereville, CO"],
        "HVAC": zips_in("CO", ["Jefferson", "Denver", "Larimer"]),
    },
    "Peak Roofing Co": {
        "Roofing": ["Arvada, CO", "Westminster, CO", "Highlands Ranch, CO", "Castle Rock, CO", "Broomfield, CO", "Golden, CO"],
    },
    "Summit HVAC": {
        "HVAC": ["Fort Collins, CO", "Loveland, CO", "Greeley, CO", "Windsor, CO"],
    },
    "Old Buyer": {
        "Roofing": zips_in("CO", ["Denver"])[:10],
    },
}


def rows_for(tab: dict[str, list[str]]) -> list[list[str]]:
    headers = list(tab)
    depth = max(len(v) for v in tab.values())
    out = [headers]
    for i in range(depth):
        out.append([tab[h][i] if i < len(tab[h]) else "" for h in headers])
    return out


def main() -> None:
    sheets: dict[str, list[list[str]]] = {
        "_buyers": [["buyer", "status", "notes"], *[list(b) for b in BUYERS]],
        "_verticals": [["vertical", "notes"], *[list(v) for v in VERTICALS]],
    }
    for name, tab in TABS.items():
        sheets[name] = rows_for(tab)

    wb = Workbook()
    wb.remove(wb.active)
    head_font = Font(bold=True)
    head_fill = PatternFill("solid", fgColor="E8EEF9")
    for name, rows in sheets.items():
        ws = wb.create_sheet(name)
        for r, row in enumerate(rows, start=1):
            for c, val in enumerate(row, start=1):
                cell = ws.cell(row=r, column=c, value=val)
                cell.number_format = "@"          # text, so leading zeros survive
                if r == 1:
                    cell.font = head_font
                    cell.fill = head_fill
        ws.freeze_panes = "A2"
        for col in ws.columns:
            ws.column_dimensions[col[0].column_letter].width = 26 if name.startswith("_") else 18
        with (MOCK / f"{name}.csv").open("w", newline="") as f:
            csv.writer(f).writerows(rows)

    out = MOCK / "Buyer Zips (mock).xlsx"
    wb.save(out)
    for name, rows in sheets.items():
        print(f"{name:24s} {len(rows) - 1:5d} rows x {len(rows[0])} cols")
    print("wrote", out)


if __name__ == "__main__":
    main()

"""Fixture for `python-xlsx.test.ts`: a small workbook with a pivot-ish summary and a chart.

Every timestamp a workbook would otherwise mint from the clock is pinned to
`SOURCE_DATE_EPOCH`, which the host derives from the trigger event — so two runs of the same
trigger produce the same bytes once the zip framing is normalized away.
"""
import datetime
import json
import os
import pathlib

import xlsxwriter

epoch = int(os.environ["SOURCE_DATE_EPOCH"])
created = datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc).replace(tzinfo=None)

rows = json.loads(pathlib.Path("in/trigger.json").read_text())["rows"]

pathlib.Path("out/files/reports").mkdir(parents=True, exist_ok=True)
book = xlsxwriter.Workbook("out/files/reports/pricing.xlsx", {"default_date_format": "yyyy-mm-dd"})
book.set_properties({"title": "Pricing", "author": "tabductor", "created": created})

sheet = book.add_worksheet("pricing")
sheet.write_row(0, 0, ["sku", "price"])
for i, row in enumerate(rows, start=1):
    sheet.write(i, 0, row["sku"])
    sheet.write(i, 1, row["price"])

# The "pivot": one total per sku, computed here rather than by a formula, so the assertion is
# about bytes rather than about Excel's recalculation.
totals = {}
for row in rows:
    totals[row["sku"]] = totals.get(row["sku"], 0) + row["price"]

summary = book.add_worksheet("summary")
summary.write_row(0, 0, ["sku", "total"])
for i, (sku, total) in enumerate(sorted(totals.items()), start=1):
    summary.write(i, 0, sku)
    summary.write(i, 1, total)

chart = book.add_chart({"type": "column"})
chart.add_series({
    "categories": ["summary", 1, 0, len(totals), 0],
    "values": ["summary", 1, 1, len(totals), 1],
    "name": "total by sku",
})
summary.insert_chart("D2", chart)
book.close()

with open("out/emits.jsonl", "w") as f:
    f.write(json.dumps({
        "type": "report.ready",
        "packet": {"report": {"$asset": "reports/pricing.xlsx"}, "skus": len(totals)},
    }) + "\n")

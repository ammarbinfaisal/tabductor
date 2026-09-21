"""Bounded extraction using the same selector engine as browser interactions."""
import re

from fastapi import HTTPException
from playwright.async_api import Error as PlaywrightError


async def extract(root, fields, params):
    if not isinstance(fields, dict) or len(fields) > 32:
        raise HTTPException(422, "extraction supports at most 32 fields")
    offset = max(0, int(params.get("offset", 0)))
    limit = max(1, min(100, int(params.get("limit", 100))))
    max_chars = max(1, min(16000, int(params.get("maxFieldChars", 16000))))
    for name, spec in fields.items():
        if not isinstance(spec, dict):
            raise HTTPException(422, f"Invalid extraction field {name!r}")
        if spec.get("selector"):
            try:
                await root.locator(spec["selector"]).count()
            except PlaywrightError as error:
                if not re.search(r"invalid selector|not a valid selector|while parsing|Unknown engine|Unexpected token|Unsupported token|is not a valid XPath", str(error), re.I):
                    raise
                raise HTTPException(422, f"Invalid extraction selector for field {name!r}: {spec['selector']!r}. Correct this field and retry; omit it only if optional.") from None
    try:
        count = await root.count()
    except PlaywrightError as error:
        if not re.search(r"invalid selector|not a valid selector|while parsing|Unknown engine|Unexpected token|Unsupported token|is not a valid XPath", str(error), re.I):
            raise
        raise HTTPException(422, "Invalid extraction root selector; correct the item selector and retry") from None
    records = []
    for index in range(offset, min(count, offset + limit)):
        row = root.nth(index)
        record = {}
        for name, spec in fields.items():
            target = row.locator(spec["selector"]).first if spec.get("selector") else row
            try:
                record[name] = await target.evaluate_all("""(nodes, args) => {
                  const node = nodes[0];
                  const value = node ? (args.attr ? node.getAttribute(args.attr) : (node.textContent || '').trim()) : null;
                  if (value && value.length > args.maxChars) throw new Error('extraction field exceeds maxFieldChars; narrow the selector or increase the bound');
                  return value;
                }""", {"attr": spec.get("attr"), "maxChars": max_chars})
            except PlaywrightError as error:
                if "extraction field exceeds maxFieldChars" not in str(error):
                    raise
                raise HTTPException(422, f"Extraction field {name!r} exceeds maxFieldChars; narrow the selector or increase the bound") from None
        records.append(record)
    return records

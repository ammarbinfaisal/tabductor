/** Exact keyed equality after an explicitly selected text normalization. */
export function compareDataset(expected: Record<string, unknown>[], actual: Record<string, unknown>[], key: string, fields: string[], normalizeWhitespace = false) {
  const normalize = (v: unknown) => normalizeWhitespace && typeof v === "string" ? v.replace(/[\t\r\n]+/g, " ") : v;
  const index = (rows: Record<string, unknown>[]) => {
    const map = new Map<string, Record<string, unknown>>();
    const duplicates: string[] = [], invalid: number[] = [];
    rows.forEach((row, i) => {
      if (row[key] === null || row[key] === undefined || row[key] === "") { invalid.push(i); return; }
      const id = JSON.stringify(row[key]);
      if (map.has(id)) duplicates.push(id);
      map.set(id, row);
    });
    return { map, duplicates, invalid };
  };
  const a = index(expected), b = index(actual);
  const missing = [...a.map.keys()].filter(k => !b.map.has(k));
  const unexpected = [...b.map.keys()].filter(k => !a.map.has(k));
  const mismatches: Array<{ key: string; field: string }> = [];
  for (const [id, row] of a.map) {
    const found = b.map.get(id);
    if (found) for (const field of fields) if (!Object.hasOwn(row, field) || !Object.hasOwn(found, field) || JSON.stringify(normalize(row[field])) !== JSON.stringify(normalize(found[field]))) mismatches.push({ key: id, field });
  }
  return { verified: !missing.length && !unexpected.length && !mismatches.length && !a.duplicates.length && !b.duplicates.length && !a.invalid.length && !b.invalid.length,
    expectedCount: expected.length, actualCount: actual.length, missing, unexpected, mismatches,
    duplicates: { expected: a.duplicates, actual: b.duplicates }, invalid: { expected: a.invalid, actual: b.invalid } };
}

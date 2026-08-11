/**
 * A compiled packet schema, flattened for display (U1). The editor never shows raw JSON —
 * the schema renders as rows of name · type · detail, one nesting level deep, which is
 * exactly the shape the generator's allowlist can produce. Anything stranger degrades to
 * a plain "object" row rather than an error: display is not a validator.
 */

export type SchemaField = {
  /** Dotted for the one allowed nesting level: `source.id`. */
  name: string;
  /** `string`, `integer`, `string[]`, `enum`, `object`, … */
  type: string;
  required: boolean;
  /** The format, the enum members, or nothing. */
  detail: string | null;
};

export function schemaFields(schema: Record<string, unknown>): SchemaField[] {
  return fieldsOf(schema, "", true);
}

function fieldsOf(schema: Record<string, unknown>, prefix: string, topLevel: boolean): SchemaField[] {
  const properties = asRecord(schema.properties);
  if (!properties) return [];
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);

  return Object.entries(properties).flatMap(([key, raw]) => {
    const prop = asRecord(raw);
    if (!prop) return [];
    const name = prefix ? `${prefix}.${key}` : key;
    const row = describe(name, prop, required.has(key));
    // One nesting level, mirroring the generator's allowlist.
    const nested = topLevel && prop.type === "object" ? fieldsOf(prop, name, false) : [];
    return [row, ...nested];
  });
}

function describe(name: string, prop: Record<string, unknown>, required: boolean): SchemaField {
  if (Array.isArray(prop.enum)) {
    return { name, type: "enum", required, detail: (prop.enum as unknown[]).map(String).join(" | ") };
  }
  if ("const" in prop) {
    return { name, type: "const", required, detail: String(prop.const) };
  }
  if (prop.type === "array") {
    const items = asRecord(prop.items);
    const inner = items ? describe(name, items, false) : null;
    return { name, type: `${inner?.type ?? "unknown"}[]`, required, detail: inner?.detail ?? null };
  }
  const type = typeof prop.type === "string" ? prop.type : "object";
  const detail = typeof prop.format === "string" ? prop.format : null;
  return { name, type, required, detail };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

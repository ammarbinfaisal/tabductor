/**
 * One valid instance of a compiled packet schema, deterministically.
 *
 * This is what lets a stub task exercise a graph with no script at all: emit a sample of
 * everything it declares. The shapes handled here are exactly the allowlist the schema
 * generator is instructed to stay inside (flat-ish objects; string/number/integer/boolean;
 * enums; arrays; shallow nesting) — anything stranger degrades to `{}`, which a permissive
 * schema accepts and a strict one rejects loudly at emit, never silently.
 *
 * Deliberately not json-schema-faker: determinism is a feature (test assertions can match
 * packets exactly), and the subset is small enough that a dependency would be all risk.
 */
export function sampleFromSchema(schema: Record<string, unknown>, depth = 0): unknown {
  if (depth > 4) return {};

  if ("const" in schema) return schema.const;
  const en = schema.enum;
  if (Array.isArray(en) && en.length > 0) return en[0];

  switch (schema.type) {
    case "string":
      return sampleString(schema.format);
    case "number":
    case "integer":
      return typeof schema.minimum === "number" ? schema.minimum : 0;
    case "boolean":
      return true;
    case "null":
      return null;
    case "array": {
      const items = schema.items;
      return isRecord(items) ? [sampleFromSchema(items, depth + 1)] : [];
    }
    case "object":
    default: {
      const properties = schema.properties;
      if (!isRecord(properties)) return {};
      // Every property, not just the required ones: a sample packet exists to look like
      // real traffic in the event feed, and real traffic fills its fields.
      return Object.fromEntries(
        Object.entries(properties).flatMap(([key, prop]) =>
          isRecord(prop) ? [[key, sampleFromSchema(prop, depth + 1)]] : [],
        ),
      );
    }
  }
}

function sampleString(format: unknown): string {
  switch (format) {
    case "date-time":
      return "2026-01-01T00:00:00Z";
    case "date":
      return "2026-01-01";
    case "uri":
      return "https://example.test/sample";
    case "email":
      return "sample@example.test";
    case "uuid":
      return "00000000-0000-4000-8000-000000000000";
    default:
      return "sample";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

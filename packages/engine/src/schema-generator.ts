import { createHash } from "node:crypto";

/**
 * The seam between publish and the LLM (graph-compilation-llm.md §4 P3, minimal v1):
 * an event's packet schema is *compiled* from its plain-language description, with the
 * prompts of every task that emits or consumes it as context. The generator proposes;
 * publish's ajv-strict gate disposes — nothing a generator returns is trusted until it
 * compiles (§2 principle: LLM authors, deterministic layer gates).
 */

export type SchemaGenInput = {
  eventType: string;
  /** The author's description of the packet — the only schema-shaped thing they write. */
  description: string;
  emitters: Array<{ name: string; prompt: string | null }>;
  consumers: Array<{ name: string; prompt: string | null }>;
};

export type SchemaGenResult =
  | { ok: true; schema: Record<string, unknown> }
  | { ok: false; error: string };

export interface SchemaGenerator {
  /** Never throws — API failures and unparseable output come back as `{ ok: false }`. */
  generate(input: SchemaGenInput): Promise<SchemaGenResult>;
}

/**
 * The carry-forward key: publish regenerates an event's schema only when this hash
 * differs from the one stored with the previous version, so a publish that touches
 * nothing an event depends on costs zero generator calls and republishes the schema
 * byte-identical. Emitters and consumers are sorted by name first — reordering tasks
 * in the document is not a semantic change.
 */
export function promptHashOf(input: SchemaGenInput): string {
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const canonical = JSON.stringify({
    type: input.eventType,
    description: input.description,
    emitters: [...input.emitters].sort(byName),
    consumers: [...input.consumers].sort(byName),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Deterministic generator for tests and seed helpers: a fixed schema per type where
 * given, a permissive object otherwise. No network, no model — the one true publish
 * path stays exercised without either.
 */
export function staticSchemaGenerator(
  schemas: Record<string, Record<string, unknown>> = {},
): SchemaGenerator {
  return {
    generate: (input) =>
      Promise.resolve({ ok: true, schema: schemas[input.eventType] ?? { type: "object" } }),
  };
}

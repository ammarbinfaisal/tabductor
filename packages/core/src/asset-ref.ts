/**
 * The asset-ref fragment (S5d, techical_plan §13.5, §18 decision 2/deliverable §18.2):
 * `{asset_id, path, mime, sha256}`, the one shape a packet uses to point at something the
 * asset store holds. It lives here — not in `packages/assets` or `packages/engine` — because
 * both of those already depend on `@tabductor/core` with no cycle, and this fragment is
 * consumed by both: the store mints values of this shape, the engine's schema compiler and
 * both ajv instances (`packet-schema.ts`'s runtime validator, `graph.ts`'s publish-time
 * strict gate) register it so a compiled packet schema can `$ref` it instead of every event
 * inventing its own asset shape.
 *
 * A plain JSON Schema object, not a zod schema: the two ajv instances that register it
 * (`ajv.addSchema(ASSET_REF_SCHEMA, "assetRef")`) speak JSON Schema, and packet schemas are
 * JSON Schema end to end (`schema-generator.ts`'s doc comment) — introducing zod here would
 * be a second schema language for the one shape that has to agree with both.
 */
export const ASSET_REF_SCHEMA = {
  type: "object",
  properties: {
    asset_id: { type: "string" },
    path: { type: "string" },
    mime: { type: "string" },
    sha256: { type: "string" },
  },
  required: ["asset_id", "path", "mime", "sha256"],
  additionalProperties: false,
} as const;

/** The shape `ASSET_REF_SCHEMA` describes, for code that builds or reads one. */
export type AssetRef = {
  asset_id: string;
  path: string;
  mime: string;
  sha256: string;
};

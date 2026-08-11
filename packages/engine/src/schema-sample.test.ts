import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { sampleFromSchema } from "./schema-sample.js";

/**
 * The sampler's whole contract: for every shape in the generator's allowlist, its sample
 * validates against the schema it was sampled from. Asserted with ajv itself, because
 * "looks right" is not the property — "passes the exact validator the emit path runs" is.
 */

const CASES: Array<[string, Record<string, unknown>]> = [
  ["permissive object", { type: "object" }],
  [
    "flat object with required strings and formats",
    {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        found_at: { type: "string", format: "date-time" },
        author: { type: "string" },
      },
      required: ["url", "found_at"],
      additionalProperties: false,
    },
  ],
  [
    "numbers, integers, booleans, enum",
    {
      type: "object",
      properties: {
        score: { type: "number", minimum: 0.5 },
        rank: { type: "integer" },
        relevant: { type: "boolean" },
        kind: { enum: ["tweet", "reply", "retweet"] },
      },
      required: ["score", "rank", "relevant", "kind"],
      additionalProperties: false,
    },
  ],
  [
    "arrays and one level of nesting",
    {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        source: {
          type: "object",
          properties: { id: { type: "string", format: "uuid" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
      required: ["tags", "source"],
      additionalProperties: false,
    },
  ],
  ["const", { type: "object", properties: { v: { const: 2 } }, required: ["v"] }],
];

describe("sampleFromSchema", () => {
  it.each(CASES)("produces a valid instance: %s", (_name, schema) => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    const sample = sampleFromSchema(schema);
    expect(validate(sample), JSON.stringify({ sample, errors: validate.errors })).toBe(true);
  });

  it("is deterministic", () => {
    const schema = CASES[1]![1];
    expect(sampleFromSchema(schema)).toEqual(sampleFromSchema(schema));
  });
});

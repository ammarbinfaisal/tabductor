import { loadConfig } from "@tabductor/core";
import type { SchemaGenerator } from "@tabductor/engine";
import { anthropicSchemaGenerator } from "@tabductor/engine/anthropic";

/**
 * The publish-time schema compiler, composed once per process like the db pool. Without a
 * key, publishing still works for every event whose hash matches the previous version —
 * carry-forward needs no model — and only *changed* events fail, with this message in
 * their compile-report entry telling the operator exactly what to set.
 */
const store = globalThis as { __tabductorSchemaGen?: SchemaGenerator };

export function schemaGenerator(): SchemaGenerator {
  store.__tabductorSchemaGen ??= build();
  return store.__tabductorSchemaGen;
}

function build(): SchemaGenerator {
  const { ANTHROPIC_API_KEY } = loadConfig();
  if (ANTHROPIC_API_KEY) return anthropicSchemaGenerator({ apiKey: ANTHROPIC_API_KEY });
  return {
    generate: () =>
      Promise.resolve({
        ok: false,
        error: "schema generation unavailable: ANTHROPIC_API_KEY is not set",
      }),
  };
}

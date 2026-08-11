import { loadConfig } from "@tabductor/core";
import type { SchemaGenerator } from "@tabductor/engine";
import { aiSchemaGenerator, providerFromEnv } from "@tabductor/engine/ai";

/**
 * The publish-time schema compiler, composed once per process like the db pool. The provider
 * is whichever key the environment holds — Anthropic first, then OpenAI.
 *
 * Without a key, publishing still works for every event whose hash matches the previous
 * version — carry-forward needs no model — and only *changed* events fail, with this message
 * in their compile-report entry telling the operator exactly what to set.
 */
const store = globalThis as { __tabductorSchemaGen?: SchemaGenerator };

export function schemaGenerator(): SchemaGenerator {
  store.__tabductorSchemaGen ??= build();
  return store.__tabductorSchemaGen;
}

function build(): SchemaGenerator {
  const { ANTHROPIC_API_KEY, OPENAI_API_KEY, SCHEMA_MODEL } = loadConfig();
  const chosen = providerFromEnv({ ANTHROPIC_API_KEY, OPENAI_API_KEY });
  if (chosen) return aiSchemaGenerator({ ...chosen, model: SCHEMA_MODEL });
  return {
    generate: () =>
      Promise.resolve({
        ok: false,
        error: "schema generation unavailable: neither ANTHROPIC_API_KEY nor OPENAI_API_KEY is set",
      }),
  };
}

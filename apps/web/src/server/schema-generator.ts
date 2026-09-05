import { loadConfig } from "@tabductor/core";
import { staticPromptCompiler, type PromptCompiler, type SchemaGenerator } from "@tabductor/engine";
import { aiPromptCompiler, aiSchemaGenerator, providerFromEnv } from "@tabductor/engine/ai";

/**
 * The publish-time schema compiler, composed once per process like the db pool. The provider
 * is whichever key the environment holds — Anthropic first, then OpenAI.
 *
 * Without a key, publishing still works for every event whose hash matches the previous
 * version — carry-forward needs no model — and only *changed* events fail, with this message
 * in their compile-report entry telling the operator exactly what to set.
 */
const store = globalThis as { __tabductorSchemaGen?: SchemaGenerator; __tabductorPromptCompiler?: PromptCompiler };

export function schemaGenerator(): SchemaGenerator {
  store.__tabductorSchemaGen ??= build();
  return store.__tabductorSchemaGen;
}

/**
 * The other half of what a publish compiles: each node's internal prompt. Same key, same
 * provider; without one the deterministic brief is the whole compiled prompt, which — unlike
 * a missing schema — is a working outcome the compile report merely labels `brief`.
 */
export function promptCompiler(): PromptCompiler {
  store.__tabductorPromptCompiler ??= buildPromptCompiler();
  return store.__tabductorPromptCompiler;
}

function buildPromptCompiler(): PromptCompiler {
  const { ANTHROPIC_API_KEY, OPENAI_API_KEY, SCHEMA_MODEL } = loadConfig();
  const chosen = providerFromEnv({ ANTHROPIC_API_KEY, OPENAI_API_KEY });
  return chosen ? aiPromptCompiler({ ...chosen, model: SCHEMA_MODEL }) : staticPromptCompiler();
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

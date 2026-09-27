import { createModelResolver, parseModelRates, getGraphAuthoringModel } from "@tabductor/engine";
import { configuredKeyWrapper } from "@tabductor/secrets";
import { db, pool as databasePool } from "./db.js";
import { AppError, loadConfig } from "@tabductor/core";
import {
  staticPromptCompiler,
  type GraphCompiler,
  type PromptCompiler,
  type SchemaGenerator,
} from "@tabductor/engine";
import { fundedAuthoringModels, aiGraphCompiler, aiPromptCompiler, aiSchemaGenerator, providerFromEnv } from "@tabductor/engine/ai";
import type { Pool } from "pg";

/**
 * The publish-time schema compiler, composed once per process like the db pool. The provider
 * is whichever key the environment holds — AI Gateway first, then Anthropic and OpenAI.
 *
 * Without a key, publishing still works for every event whose hash matches the previous
 * version — carry-forward needs no model — and only *changed* events fail, with this message
 * in their compile-report entry telling the operator exactly what to set.
 */
const store = globalThis as { __tabductorSchemaGen?: SchemaGenerator; __tabductorPromptCompiler?: PromptCompiler };

export function graphCompiler(pool: Pool): GraphCompiler {
  return {
    async compile(input) {
      const selection = await getGraphAuthoringModel(db());
      const config = loadConfig();
      const apiKey = selection.provider === "openai" ? config.OPENAI_API_KEY : config.ANTHROPIC_API_KEY;
      if (!apiKey) throw new AppError("model_platform_unavailable", `Graph authoring provider ${selection.provider} is unavailable. Configure its platform API key or change the model in Admin → Providers.`);
      return aiGraphCompiler({ ...selection, apiKey, pool }).compile(input);
    },
  };
}

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
  const { ANTHROPIC_API_KEY, OPENAI_API_KEY, AI_GATEWAY_API_KEY, SCHEMA_MODEL } = loadConfig();
  const chosen = providerFromEnv({ ANTHROPIC_API_KEY, OPENAI_API_KEY, AI_GATEWAY_API_KEY });
  return chosen ? aiPromptCompiler({ ...chosen, model: SCHEMA_MODEL }) : staticPromptCompiler();
}

function build(): SchemaGenerator {
  const { ANTHROPIC_API_KEY, OPENAI_API_KEY, AI_GATEWAY_API_KEY, SCHEMA_MODEL } = loadConfig();
  const chosen = providerFromEnv({ ANTHROPIC_API_KEY, OPENAI_API_KEY, AI_GATEWAY_API_KEY });
  if (chosen) return aiSchemaGenerator({ ...chosen, model: SCHEMA_MODEL });
  return {
    generate: () =>
      Promise.resolve({
        ok: false,
        error: "schema generation unavailable: neither ANTHROPIC_API_KEY nor OPENAI_API_KEY is set",
      }),
  };
}

/** Request-scoped factories prevent account identity leaking through a process-global model. */
export function accountModelServices(accountId: string, workflowId?: string) {
  const config = loadConfig();
  const resolver = createModelResolver({ db: db(), wrapper: configuredKeyWrapper(config), rates: parseModelRates(config.MODEL_USD_RATES_JSON),
    platformKeys: { ...(config.OPENAI_API_KEY ? { openai: config.OPENAI_API_KEY } : {}), ...(config.ANTHROPIC_API_KEY ? { anthropic: config.ANTHROPIC_API_KEY } : {}) } });
  return fundedAuthoringModels(resolver, { accountId, ...(workflowId ? { workflowId } : {}) }, databasePool());
}

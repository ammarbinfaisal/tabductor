import { createAnthropic } from "@ai-sdk/anthropic";
import { createGateway } from "@ai-sdk/gateway";
import { estimateModelInput } from "@tabductor/core";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output, jsonSchema, type LanguageModel } from "ai";
import { llmPromptCompiler, PROMPT_SYSTEM_PROMPT, type PromptCompiler } from "./prompt-compiler.js";
import type { SchemaGenerator } from "./schema-generator.js";
import { graphDraftArtifactSchema, llmGraphCompiler, type GraphCompiler } from "./graph-authoring.js";
import { llmSchemaGenerator, SCHEMA_SYSTEM_PROMPT, type ChatTransport } from "./schema-generator-llm.js";

/**
 * The transport half of the schema compiler, over the Vercel AI SDK so a provider is a
 * config line rather than a second implementation. The compiler's actual behaviour — the
 * instructions, the ajv-strict gate, the bounded self-repair loop — lives in
 * `schema-generator-llm.ts` and does not know which provider answered.
 *
 * That seam is deliberate: `ChatTransport` is ours, not the SDK's, so the tested loop is
 * unaffected by an SDK upgrade, and a provider added here cannot quietly change how
 * schemas are gated (`docs/event-centric-model.md` §3).
 *
 * Constructed only at composition roots that hold an API key (the web server today —
 * publish runs in the tRPC mutation). Everything else takes the interface.
 */

export type SchemaProvider = "anthropic" | "openai" | "openai-compatible" | "gateway";

/** Flagship per provider. Both are overridable — a deployment pinning a model outlives our default. */
const DEFAULT_MODEL: Record<SchemaProvider, string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-5.2",
  "openai-compatible": "gpt-5.2",
  gateway: "openai/gpt-5.2",
};

export interface AiSchemaGeneratorOptions {
  provider: SchemaProvider;
  apiKey: string;
  model?: string | undefined;
  baseUrl?: string | undefined;
}

export function aiSchemaGenerator(opts: AiSchemaGeneratorOptions): SchemaGenerator {
  return llmSchemaGenerator(chatTransport(languageModel(opts), SCHEMA_SYSTEM_PROMPT, opts.provider));
}

/** The prompt compiler's model layer (`prompt-compiler.ts`), over the same transport shape
 * and the same provider selection as the schema compiler — one key configures both halves
 * of what a publish compiles. */
export function aiPromptCompiler(opts: AiSchemaGeneratorOptions): PromptCompiler {
  return llmPromptCompiler(chatTransport(languageModel(opts), PROMPT_SYSTEM_PROMPT));
}

export function aiGraphCompiler(opts: AiSchemaGeneratorOptions & { pool?: import("pg").Pool }): GraphCompiler {
  return llmGraphCompiler(chatTransport(languageModel(opts), "You design checked workflow graphs.", opts.provider, "graph"), {
    ...(opts.pool ? { pool: opts.pool } : {}),
  });
}

/** Enforce JSON at the provider while leaving parsing/validation to the compiler's
 * repair loop. Eager SDK parsing would throw before funded calls settle their usage.
 * Anthropic needs a schema and a forced tool; its schema-free JSON mode is ignored.
 * Dynamic graph limits and packet properties are checked by our existing gates. */
function jsonGenerationOptions(provider: SchemaProvider, output: "generic" | "graph" = "generic") {
  // OpenAI and compatible endpoints use JSON mode for graph authoring because OpenAI's
  // strict structured outputs reject optional properties in the graph contract. The compiler
  // still parses with graphDraftArtifactSchema and runs the deterministic gate/repair loop.
  // Anthropic needs a schema and a forced tool because its schema-free JSON mode is ignored.
  const format = provider === "anthropic"
    ? output === "graph"
      ? Output.object({ schema: graphDraftArtifactSchema, name: "workflow_graph" })
      : Output.object({ schema: jsonSchema({ type: "object", additionalProperties: true }) })
    : Output.json();
  return {
    // Keep text parsing in our repair loop. `Output.object` supplies the provider schema;
    // `Output.text` deliberately avoids throwing before llmGraphCompiler can feed a bad
    // response back to the model for repair.
    output: { ...Output.text(), name: output === "graph" ? "workflow_graph" : "json", responseFormat: format.responseFormat },
    ...(provider === "anthropic"
      ? { providerOptions: { anthropic: { structuredOutputMode: "jsonTool" } } }
      : {}),
  };
}

function chatTransport(model: LanguageModel, system: string, jsonProvider?: SchemaProvider, output?: "graph"): ChatTransport {
  return {
    async complete(turns) {
      const result = await generateText({
        model,
        system,
        messages: turns.map((t) => ({ role: t.role, content: t.content })),
        ...(jsonProvider ? jsonGenerationOptions(jsonProvider, output ?? "generic") : {}),
      });
      // A content filter is a refusal: the loop should report it rather than spend its
      // repair attempts rephrasing a request the provider has already declined.
      if (result.finishReason === "content-filter") return { refused: true };
      return { text: result.text };
    },
  };
}

function languageModel(opts: AiSchemaGeneratorOptions): LanguageModel {
  const id = opts.model ?? DEFAULT_MODEL[opts.provider];
  switch (opts.provider) {
    case "anthropic":
      return createAnthropic({ apiKey: opts.apiKey })(id);
    case "openai":
      return createOpenAI({ apiKey: opts.apiKey })(id);
    case "openai-compatible":
      if (!opts.baseUrl) throw new Error("an OpenAI-compatible model requires an API base URL");
      return createOpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl, name: "openai-compatible" }).chat(id);
    case "gateway":
      return createGateway({ apiKey: opts.apiKey })(id as Parameters<ReturnType<typeof createGateway>>[0]);
  }
}

/**
 * Provider selection from whatever keys the environment happens to hold. AI Gateway wins so
 * OpenAI-routed graph authoring gets its structured-output contract; Anthropic and direct
 * OpenAI remain fallbacks. `null` is a working mode: publishing still carries unchanged
 * schemas forward by hash.
 */
export function providerFromEnv(env: {
  ANTHROPIC_API_KEY?: string | undefined;
  OPENAI_API_KEY?: string | undefined;
  AI_GATEWAY_API_KEY?: string | undefined;
}): { provider: SchemaProvider; apiKey: string } | null {
  if (env.AI_GATEWAY_API_KEY) return { provider: "gateway", apiKey: env.AI_GATEWAY_API_KEY };
  if (env.ANTHROPIC_API_KEY) return { provider: "anthropic", apiKey: env.ANTHROPIC_API_KEY };
  if (env.OPENAI_API_KEY) return { provider: "openai", apiKey: env.OPENAI_API_KEY };
  return null;
}

/** All hosted authoring phases share the same account/workflow funding resolver. */
export function fundedAuthoringModels(resolver: import("../model-funding.js").ModelResolver,
  scope: Omit<import("../model-funding.js").ModelScope, "purpose">, pool?: import("pg").Pool) {
  const usageOf = (usage: import("ai").LanguageModelUsage) => ({ input: usage.inputTokens ?? NaN,
    output: usage.outputTokens ?? NaN, cachedInput: usage.inputTokenDetails.cacheReadTokens ?? 0,
    reasoning: usage.outputTokenDetails.reasoningTokens ?? 0 });
  const transport = (purpose: import("../model-funding.js").ModelPurpose, system: string): ChatTransport => ({
    complete: (turns) => resolver.execute({ ...scope, purpose }, estimateModelInput({ system, turns }), async (config) => {
      const result = await generateText({ model: languageModel(config), system, messages: turns,
        ...(purpose === "graph" || purpose === "schema" ? jsonGenerationOptions(config.provider, purpose === "graph" ? "graph" : "generic") : {}),
        maxOutputTokens: config.maxOutputTokens, maxRetries: 0 });
      const value: Awaited<ReturnType<ChatTransport["complete"]>> = result.finishReason === "content-filter" ? { refused: true } : { text: result.text };
      return { value, usage: usageOf(result.usage) };
    }),
  });
  return { schemaGenerator: llmSchemaGenerator(transport("schema", SCHEMA_SYSTEM_PROMPT)),
    promptCompiler: llmPromptCompiler(transport("prompt", PROMPT_SYSTEM_PROMPT)),
    graphCompiler: llmGraphCompiler(transport("graph", "You design checked workflow graphs."), { ...(pool ? { pool } : {}) }) };
}

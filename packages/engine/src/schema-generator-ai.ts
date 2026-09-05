import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, type LanguageModel } from "ai";
import { llmPromptCompiler, PROMPT_SYSTEM_PROMPT, type PromptCompiler } from "./prompt-compiler.js";
import type { SchemaGenerator } from "./schema-generator.js";
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

export type SchemaProvider = "anthropic" | "openai";

/** Flagship per provider. Both are overridable — a deployment pinning a model outlives our default. */
const DEFAULT_MODEL: Record<SchemaProvider, string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-5.2",
};

export interface AiSchemaGeneratorOptions {
  provider: SchemaProvider;
  apiKey: string;
  model?: string | undefined;
}

export function aiSchemaGenerator(opts: AiSchemaGeneratorOptions): SchemaGenerator {
  return llmSchemaGenerator(chatTransport(languageModel(opts), SCHEMA_SYSTEM_PROMPT));
}

/** The prompt compiler's model layer (`prompt-compiler.ts`), over the same transport shape
 * and the same provider selection as the schema compiler — one key configures both halves
 * of what a publish compiles. */
export function aiPromptCompiler(opts: AiSchemaGeneratorOptions): PromptCompiler {
  return llmPromptCompiler(chatTransport(languageModel(opts), PROMPT_SYSTEM_PROMPT));
}

function chatTransport(model: LanguageModel, system: string): ChatTransport {
  return {
    async complete(turns) {
      const result = await generateText({
        model,
        system,
        messages: turns.map((t) => ({ role: t.role, content: t.content })),
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
  }
}

/**
 * Provider selection from whatever keys the environment happens to hold. Anthropic wins when
 * both are set — the prompt in `schema-generator-llm.ts` was written and checked against
 * Claude — and `null` means no key at all, which is a working mode: publishing still carries
 * unchanged schemas forward by hash.
 */
export function providerFromEnv(env: {
  ANTHROPIC_API_KEY?: string | undefined;
  OPENAI_API_KEY?: string | undefined;
}): { provider: SchemaProvider; apiKey: string } | null {
  if (env.ANTHROPIC_API_KEY) return { provider: "anthropic", apiKey: env.ANTHROPIC_API_KEY };
  if (env.OPENAI_API_KEY) return { provider: "openai", apiKey: env.OPENAI_API_KEY };
  return null;
}

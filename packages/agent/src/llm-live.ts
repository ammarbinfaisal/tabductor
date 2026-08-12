import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, tool, type LanguageModel, type ToolSet } from "ai";
import { AppError } from "@tabductor/core";
import { z } from "zod";
import type { Llm, LlmRequest, LlmResponse, ToolDef } from "./llm.js";

/**
 * The live transport, over the Vercel AI SDK rather than `@anthropic-ai/sdk` directly — the
 * mandated deviation from the S4a spec, mirroring `packages/engine`'s schema compiler
 * (`schema-generator-ai.ts`, commit `60ce054`) so a provider is a config line instead of a
 * second implementation. Reasons, recorded here and in the subphase doc's deviation note:
 * (a) this machine and the deployment it targets carry only `OPENAI_API_KEY`, so an
 * Anthropic-only adapter could never run live or record a transcript here; (b) `ai` +
 * `@ai-sdk/{anthropic,openai}` are already workspace dependencies, so this adds no provider-
 * abstraction layer of our own — the spec's "no hypothetical non-Anthropic abstraction" rule
 * is satisfied by not writing one, not by refusing the SDK that already exists.
 *
 * Tools cross the SDK boundary with no `execute` — `generateText` therefore always returns
 * tool calls unexecuted, which is exactly what `Llm.complete`'s contract wants: the S4b loop
 * runs them, this file never does.
 */

export type LlmProvider = "anthropic" | "openai";

/** Flagship per provider — `claude-sonnet-5` per the spec's own choice for this adapter;
 * `gpt-5.2` mirrors the schema compiler's OpenAI default (`engine/schema-generator-ai.ts`)
 * rather than inventing a second one. Both overridable per call. */
const DEFAULT_MODEL: Record<LlmProvider, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.2",
};

export type LiveLlmOptions = {
  provider: LlmProvider;
  apiKey: string;
  model?: string | undefined;
};

const toolCallArgsSchema = z.record(z.string(), z.unknown());

/**
 * Every S4b tool is named `page.goto`/`network.read`/… — the dotted convention the whole
 * design doc uses (`mcp.imagegen.create`, `assets.write`, …) — but both providers' function-
 * name field is constrained to `^[a-zA-Z0-9_-]+$` and rejects a literal `.` outright (a live-
 * only failure: replay never sends a name through either provider's validator, so nothing
 * before this caught it). The registry's names stay exactly as designed; only the wire
 * encoding changes, and only in this file, which is the one place a name crosses into a
 * provider's schema. `__` is the substitution because no tool in this codebase's registries
 * uses it, so the mapping is unambiguously reversible in both directions.
 */
const WIRE_SEP = "__";
const toWireName = (name: string): string => name.replaceAll(".", WIRE_SEP);
const fromWireName = (name: string): string => name.replaceAll(WIRE_SEP, ".");

function toAiTools(tools: ToolDef[]): ToolSet {
  const out: ToolSet = {};
  for (const t of tools) {
    out[toWireName(t.name)] = tool({ description: t.description, inputSchema: t.parameters });
  }
  return out;
}

/** The model id a call will actually hit — `opts.model` if given, else the provider's
 * default. Exposed so callers that only know `{provider, model?}` (the metrics label, the
 * price table) don't have to duplicate `DEFAULT_MODEL`'s lookup themselves. */
export function resolveModelId(opts: { provider: LlmProvider; model?: string | undefined }): string {
  return opts.model ?? DEFAULT_MODEL[opts.provider];
}

export function liveLlm(opts: LiveLlmOptions): Llm {
  const model = languageModel(opts);

  return {
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const result = await generateText({
        model,
        system: req.system,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        tools: toAiTools(req.tools),
      });

      const toolCalls = result.toolCalls.map((tc) => {
        const name = fromWireName(tc.toolName);
        const parsed = toolCallArgsSchema.safeParse(tc.input);
        if (!parsed.success) {
          throw new AppError(
            "llm_tool_call_invalid",
            `tool call "${name}" returned non-object arguments`,
            { details: { tool: name, issues: parsed.error.issues } },
          );
        }
        return { id: tc.toolCallId, name, args: parsed.data };
      });

      return {
        // A content filter still surfaces text some providers pad with an empty string —
        // normalize that to `undefined` so a caller can `if (res.text)` without a special case.
        text: result.text || undefined,
        toolCalls,
        usage: { in: result.usage.inputTokens ?? 0, out: result.usage.outputTokens ?? 0 },
      };
    },
  };
}

function languageModel(opts: LiveLlmOptions): LanguageModel {
  const id = resolveModelId(opts);
  switch (opts.provider) {
    case "anthropic":
      return createAnthropic({ apiKey: opts.apiKey })(id);
    case "openai":
      return createOpenAI({ apiKey: opts.apiKey })(id);
  }
}

/**
 * Provider selection from whatever key the environment holds — identical shape to
 * `engine/schema-generator-ai.ts`'s `providerFromEnv`, deliberately: two independent
 * composition roots (the web server's schema compiler, this package's agent loop) should not
 * decide "which provider" by two different rules. Anthropic wins when both are set; `null`
 * means neither, which the caller must treat as "no live/record mode available."
 */
export function providerFromEnv(env: {
  ANTHROPIC_API_KEY?: string | undefined;
  OPENAI_API_KEY?: string | undefined;
}): { provider: LlmProvider; apiKey: string } | null {
  if (env.ANTHROPIC_API_KEY) return { provider: "anthropic", apiKey: env.ANTHROPIC_API_KEY };
  if (env.OPENAI_API_KEY) return { provider: "openai", apiKey: env.OPENAI_API_KEY };
  return null;
}

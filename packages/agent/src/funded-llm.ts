import type { TraceRecorder } from "@tabductor/browser";
import type { ModelResolver, ModelScope } from "@tabductor/engine";
import type { Llm } from "./llm.js";
import { liveLlm, toModelMessages } from "./llm-live.js";
import { estimateModelInput } from "@tabductor/core";
import { asSchema } from "ai";

/** Resolve funding for each call, including recovery and background compilation. */
export function fundedLlm(resolver: ModelResolver, scope: () => Promise<ModelScope>, trace?: TraceRecorder): Llm {
  return { async complete(request) {
    const owner = await scope();
    const input = estimateModelInput({ system: request.system, messages: toModelMessages(request.messages),
      tools: await Promise.all(request.tools.map(async (tool) => ({ name: tool.name, description: tool.description,
        parameters: await asSchema(tool.parameters).jsonSchema }))) });
    const result = await resolver.execute(owner, input, async (config) => {
      const value = await liveLlm(config).complete(request);
      return { value, usage: { input: value.usage.in, output: value.usage.out,
        cachedInput: value.usage.cachedInput ?? 0, reasoning: value.usage.reasoning ?? 0 } };
    }).catch(async (error: unknown) => {
      await trace?.record("llm", { phase: "rejected_or_failed", ...input,
        code: error instanceof Error && "code" in error ? String(error.code) : "model_call_failed" });
      throw error;
    });
    await trace?.record("llm", { usage: result.usage, tool_calls: result.toolCalls.map((call) => call.name) });
    return result;
  } };
}

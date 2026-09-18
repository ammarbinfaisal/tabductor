import type { TraceRecorder } from "@tabductor/browser";
import type { ModelResolver, ModelScope } from "@tabductor/engine";
import type { Llm } from "./llm.js";
import { liveLlm } from "./llm-live.js";

/** Resolve funding for each call, including recovery and background compilation. */
export function fundedLlm(resolver: ModelResolver, scope: () => Promise<ModelScope>, trace?: TraceRecorder): Llm {
  return { async complete(request) {
    const owner = await scope();
    const result = await resolver.execute(owner, { inputTokenBound: Buffer.byteLength(JSON.stringify(request), "utf8") + 4096 }, async (config) => {
      const value = await liveLlm(config).complete(request);
      return { value, usage: { input: value.usage.in, output: value.usage.out,
        cachedInput: value.usage.cachedInput ?? 0, reasoning: value.usage.reasoning ?? 0 } };
    });
    await trace?.record("llm", { usage: result.usage, tool_calls: result.toolCalls.map((call) => call.name) });
    return result;
  } };
}

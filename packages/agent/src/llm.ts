import { createHash } from "node:crypto";
import { AppError } from "@tabductor/core";
import type { TraceRecorder } from "@tabductor/browser";
import type { Metrics } from "@tabductor/telemetry";
import type { z } from "zod";
import { liveLlm, providerFromEnv, resolveModelId, type LlmProvider } from "./llm-live.js";
import { costUsd } from "./pricing.js";
import { recordLlm, replayLlm } from "./transcript.js";

/**
 * The interface S4b's loop composes: one call in, one call out, no conversation state held
 * here — the loop owns `messages`, this just answers one turn. `system`/`messages` are plain
 * text, matching the schema compiler's `ChatTransport` precedent (`engine/schema-generator-
 * llm.ts`) rather than the richer multi-part message shape a provider SDK natively wants;
 * anything richer is S4b's problem to build on top; not ours to anticipate.
 */
export type LlmMessage = { role: "user" | "assistant"; content: string };

/** A tool's parameters are a zod schema, not hand-written JSON Schema — validated at the
 * definition site and converted to JSON Schema by the AI SDK when a request is live. */
export type ToolDef = {
  name: string;
  description: string;
  parameters: z.ZodTypeAny;
};

export type LlmRequest = {
  system: string;
  messages: LlmMessage[];
  tools: ToolDef[];
};

export type LlmToolCall = { id: string; name: string; args: Record<string, unknown> };

export type LlmResponse = {
  text?: string;
  toolCalls: LlmToolCall[];
  usage: { in: number; out: number };
};

export type Llm = { complete(req: LlmRequest): Promise<LlmResponse> };

/**
 * The one thing every mode does identically (spec: "every call, all modes"), so it wraps
 * whichever implementation `createLlm` picked rather than living inside each of them. Never
 * prompt or completion text — a hash, token counts, and which tools were called by name
 * (telemetry/trace content rules; §16 Threat 1). The tool *parameter schemas* are not
 * serializable JSON on their own (they're zod objects), so the hash covers `system`,
 * `messages` and tool names/descriptions — enough to detect a changed prompt, not a faithful
 * byte-for-byte digest of the wire request.
 */
function withTrace(llm: Llm, trace: TraceRecorder | undefined): Llm {
  if (!trace) return llm;
  return {
    async complete(req) {
      const promptHash = createHash("sha256")
        .update(
          JSON.stringify({
            system: req.system,
            messages: req.messages,
            tools: req.tools.map((t) => ({ name: t.name, description: t.description })),
          }),
        )
        .digest("hex");
      const res = await llm.complete(req);
      await trace.record("llm", {
        prompt_hash: promptHash,
        usage: res.usage,
        tool_calls: res.toolCalls.map((c) => c.name),
      });
      return res;
    },
  };
}

/**
 * §17.2's `llm_tokens_total`/`llm_cost_usd_total` rows, counted here so every caller of
 * `createLlm` gets them for free — the injected-meter shape every other package in this repo
 * follows (`PolicyGate`, `TraceRecorder`). Replay is deliberately excluded: it spends nothing
 * and calls no provider, so a dollar figure recorded against it would be a real number in a
 * metric that means "money we spent" — worse than a metric with a hole in it for replay runs,
 * which CI runs constantly. Live and record both metered identically, in `model`'s pricing.
 */
function withMetrics(
  llm: Llm,
  opts: { metrics: Metrics | undefined; model: string; costLabels: { kind: string; mode: string } | undefined },
): Llm {
  const { metrics, model, costLabels } = opts;
  if (!metrics) return llm;
  return {
    async complete(req) {
      const res = await llm.complete(req);
      metrics.llmTokens.add(res.usage.in, { model, direction: "in" });
      metrics.llmTokens.add(res.usage.out, { model, direction: "out" });
      if (costLabels) {
        metrics.llmCostUsd.add(costUsd(model, res.usage), {
          model,
          kind: costLabels.kind,
          mode: costLabels.mode,
        });
      }
      return res;
    },
  };
}

export type LlmMode = "live" | "record" | "replay";

export type CreateLlmOptions = {
  /** live/record only — the two-provider deviation's selector (§ S4a deviation note). */
  provider?: LlmProvider;
  apiKey?: string;
  model?: string;
  /** record/replay only — where the transcript is written/read. */
  fixturePath?: string;
  /** Injected like everywhere else in this codebase; absent means untraced, not broken. */
  trace?: TraceRecorder;
  /** Injected like `trace`; absent means unmetered, not broken. */
  metrics?: Metrics;
  /** `llm_cost_usd_total`'s `{kind, mode}` labels — the calling task's, not this adapter's
   * concern to know on its own. Omit to still get `llm_tokens_total` with no cost row. */
  costLabels?: { kind: string; mode: string };
};

/** live/record share the transport; replay never touches the network at all. */
export function createLlm(mode: LlmMode, opts: CreateLlmOptions): Llm {
  let base: Llm;
  let model = opts.model ?? "";
  switch (mode) {
    case "live":
    case "record": {
      if (!opts.provider || !opts.apiKey) {
        throw new AppError("llm_config_invalid", `${mode} mode needs a provider and an apiKey`, {
          details: { mode },
        });
      }
      model = resolveModelId({ provider: opts.provider, model: opts.model });
      const live = liveLlm({ provider: opts.provider, apiKey: opts.apiKey, model: opts.model });
      if (mode === "live") {
        base = live;
      } else {
        if (!opts.fixturePath) {
          throw new AppError("llm_config_invalid", "record mode needs a fixturePath", {
            details: { mode },
          });
        }
        base = recordLlm(live, opts.fixturePath);
      }
      break;
    }
    case "replay": {
      if (!opts.fixturePath) {
        throw new AppError("llm_config_invalid", "replay mode needs a fixturePath", {
          details: { mode },
        });
      }
      base = replayLlm(opts.fixturePath);
      break;
    }
  }
  const metered =
    mode === "replay" ? base : withMetrics(base, { metrics: opts.metrics, model, costLabels: opts.costLabels });
  return withTrace(metered, opts.trace);
}

export { liveLlm, providerFromEnv, type LlmProvider } from "./llm-live.js";
export { recordLlm, replayLlm } from "./transcript.js";

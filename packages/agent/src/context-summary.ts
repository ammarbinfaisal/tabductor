import { AppError, estimateModelInput } from "@tabductor/core";
import type { TraceRecorder } from "@tabductor/browser";
import type { Llm, LlmRequest } from "./llm.js";

// Reserve space for retry feedback when callers size a summarization chunk.
export const SUMMARY_RETRY_INPUT_RESERVE = 128;
const SUMMARY_MAX_CHARACTERS = 8_000;
const SUMMARY_TARGETS = [6_000, 3_000, 1_500];

/** Retry presentation failures using the original evidence, never a clipped summary.
 * The caller commits history only after this returns a complete, valid summary. */
export async function summarizeContext(
  llm: Llm,
  request: LlmRequest,
  maxInputTokens: number,
  trace?: TraceRecorder,
): Promise<string> {
  let feedback = "";
  for (const [index, target] of SUMMARY_TARGETS.entries()) {
    request.signal?.throwIfAborted();
    const attempt = {
      ...request,
      system: request.system.replace("at most 6000 characters", `at most ${target} characters`) + feedback,
    };
    if (estimateModelInput(attempt).inputTokenBound > maxInputTokens) {
      throw new AppError("model_context_limit", "Context summarization input exceeds the configured model budget");
    }
    const response = await llm.complete(attempt);
    request.signal?.throwIfAborted();
    const summary = response.text?.trim() ?? "";
    const reason = response.toolCalls.length || !summary ? "unusable_summary"
      : summary.length > SUMMARY_MAX_CHARACTERS ? "summary_too_long" : null;
    if (!reason) return summary;

    const attempts = index + 1;
    await trace?.record("runtime", { action: "context.summary_rejected", reason, attempt: attempts,
      summaryCharacters: summary.length, maxSummaryCharacters: SUMMARY_MAX_CHARACTERS,
      retrying: attempts < SUMMARY_TARGETS.length });
    if (attempts === SUMMARY_TARGETS.length) {
      throw new AppError("context_compaction_failed",
        `Context summarization failed after ${attempts} attempts (${reason}, ${summary.length} characters); original history is retained`,
        { details: { reason, attempts, summaryCharacters: summary.length, maxSummaryCharacters: SUMMARY_MAX_CHARACTERS } });
    }
    feedback = reason === "summary_too_long"
      ? `\nYour previous attempt contained ${summary.length} characters, exceeding the hard limit of ${SUMMARY_MAX_CHARACTERS}. Rewrite from the original evidence within the shorter target. Group repetitive records and preserve unresolved work and uncertain effects.`
      : "\nYour previous attempt was unusable. Return nonempty summary text only, with no tool calls.";
  }
  throw new Error("Missing context summary target");
}

import { z } from "zod";
import type { RunHandle, RunResult, TaskExecutor } from "./executor.js";

/**
 * The permanent graph-testing executor (impl-phases Phase 2): it makes the engine's
 * correctness testable without a browser or an LLM, and stays useful forever for exercising
 * graph shapes.
 *
 * Behavior is scripted in `tasks.limits_json.stub`. That is author-supplied config, not a
 * user-authored packet schema, so it is parsed with zod (ajv is reserved for packet
 * schemas). An absent or malformed `stub` block means "do nothing and succeed" — a task
 * with no script is a no-op node, not an error.
 */

const stubSchema = z.object({
  emits: z
    .array(
      z.object({
        type: z.string(),
        packet: z.unknown().optional(),
        delay_ms: z.number().nonnegative().optional(),
      }),
    )
    .optional(),
  /** Fail the run with this message, after any emits above have run. */
  fail: z.string().optional(),
  /** Block for this long — used to drive the timeout watchdog. */
  hang_ms: z.number().nonnegative().optional(),
});

export type StubScript = z.infer<typeof stubSchema>;

const limitsSchema = z.object({ stub: stubSchema.optional() });

export function parseStub(limitsJson: unknown): StubScript | undefined {
  const parsed = limitsSchema.safeParse(limitsJson);
  return parsed.success ? parsed.data.stub : undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const StubExecutor: TaskExecutor = {
  async execute(handle: RunHandle): Promise<RunResult> {
    const stub = parseStub(handle.task.limitsJson);
    if (!stub) return { ok: true };

    for (const emit of stub.emits ?? []) {
      if (emit.delay_ms) await sleep(emit.delay_ms);
      // A rejected emit (schema violation) ends the run — §4 requires the failure to
      // surface rather than the malformed packet to propagate.
      try {
        await handle.emit(emit.type, emit.packet ?? {});
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    if (stub.hang_ms) await sleep(stub.hang_ms);
    if (stub.fail) return { ok: false, error: stub.fail };
    return { ok: true };
  },
};

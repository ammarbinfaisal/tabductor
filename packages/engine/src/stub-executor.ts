import { z } from "zod";
import type { RunHandle, RunResult, TaskExecutor } from "./executor.js";
import { sampleFromSchema } from "./schema-sample.js";

/**
 * The permanent graph-testing executor (impl-phases Phase 2): it makes the engine's
 * correctness testable without a browser or an LLM, and stays useful forever for exercising
 * graph shapes.
 *
 * Behavior can be scripted in `tasks.limits_json.stub`. That is author-supplied config,
 * not a user-authored packet schema, so it is parsed with zod (ajv is reserved for packet
 * schemas). An absent or malformed `stub` block means "emit one valid sample of every
 * event this task declares, then succeed" — derived from the compiled schemas, so a graph
 * is exercisable the moment it publishes, with nothing scripted by hand. A present script
 * fully specifies behavior, including "emit nothing"; a task with neither script nor
 * declared emits is a no-op node, not an error.
 *
 * `runStubScript` is exported for `AssetExecutor` (S5a): a `kind=asset` task has no MCP
 * client or LaTeX renderer to run yet, so it runs this identical scripted-behavior contract
 * until S5c/S5d give it real tools to call — one behavior, two registrations, not a base
 * class.
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
  /**
   * Fail the first N attempts and succeed on the next — the retry policy's fixture. It
   * reads `runs.attempt` rather than counting in memory, so the behavior is a function of
   * the run row and survives the process restart the crash-recovery tests perform.
   */
  fail_times: z.number().int().nonnegative().optional(),
  /** Fail without ever retrying, whatever the task's retry policy says. */
  permanent_fail: z.string().optional(),
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

export async function runStubScript(handle: RunHandle): Promise<RunResult> {
  const stub = parseStub(handle.task.limitsJson);
  if (!stub) return emitDerived(handle);

  // `fail_times` is checked *before* the emits, not after `fail` is: an attempt that is
  // scripted to fail should look like a task that died before doing its work, so the
  // retry test can assert the downstream event fired exactly once across three attempts.
  if (stub.fail_times !== undefined && handle.run.attempt < stub.fail_times) {
    return { ok: false, error: `stub failing attempt ${handle.run.attempt}` };
  }
  if (stub.permanent_fail) return { ok: false, error: stub.permanent_fail, permanent: true };

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
}

export const StubExecutor: TaskExecutor = { execute: runStubScript };

/**
 * The scriptless path: one valid sample per declared event, synthesized from its compiled
 * schema. Emit failures end the run exactly as scripted emits do — a schema the sampler
 * cannot satisfy should be loud, not skipped.
 */
async function emitDerived(handle: RunHandle): Promise<RunResult> {
  for (const { type, schema } of await handle.declaredEmits()) {
    try {
      await handle.emit(type, sampleFromSchema(schema));
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: true };
}

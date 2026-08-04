import type { EventRow, RunRow, TaskRow } from "@tabductor/db";

/**
 * The one executor contract (impl-phases Phase 2). `StubExecutor` implements it now;
 * `AgentExecutor` (Phase 4) and `CompiledExecutor` (Phase 6) implement it later and are
 * registered under the task `mode` they serve.
 */
export interface TaskExecutor {
  execute(run: RunHandle): Promise<RunResult>;
}

export type RunResult = { ok: true } | { ok: false; error: string };

/** Everything an executor is allowed to see, plus the one thing it may do to the world. */
export type RunHandle = {
  run: RunRow;
  task: TaskRow;
  /** `null` for a run with no trigger (a schedule fire in S2b, or a manual start). */
  trigger: EventRow | null;
  /**
   * Validates `packet` against the task's declared `event_defs` schema and, if it passes,
   * publishes through the outbox in one transaction. Rejects on a schema violation — the
   * executor is expected to let that failure end the run (§4: "a packet that fails
   * validation should fail the emit rather than silently propagating malformed data").
   */
  emit: (type: string, packet: unknown) => Promise<EventRow>;
};

/** Registry is a plain object on purpose: no factory, no DI container. */
export type ExecutorRegistry = Record<string, TaskExecutor>;

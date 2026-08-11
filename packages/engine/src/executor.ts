import type { EventRow, RunRow, TaskRow } from "@tabductor/db";

/**
 * The one executor contract (impl-phases Phase 2). `StubExecutor` implements it now;
 * `AgentExecutor` (Phase 4) and `CompiledExecutor` (Phase 6) implement it later and are
 * registered under the task `mode` they serve.
 */
export interface TaskExecutor {
  execute(run: RunHandle): Promise<RunResult>;
}

/**
 * `permanent` means "do not retry this" (§15): a packet that fails validation will fail
 * validation again, and a policy denial (Phase 7) is a decision, not a fault. Absent or
 * false, the task's retry policy applies.
 */
export type RunResult = { ok: true } | { ok: false; error: string; permanent?: boolean };

/** Everything an executor is allowed to see, plus the one thing it may do to the world. */
export type RunHandle = {
  run: RunRow;
  task: TaskRow;
  /** `null` for a run with no trigger (a schedule fire in S2b, or a manual start). */
  trigger: EventRow | null;
  /**
   * Validates `packet` against the event's compiled schema for this task's workflow
   * version and, if it passes, publishes through the outbox in one transaction. Rejects on
   * a schema violation — the executor is expected to let that failure end the run (§4: "a
   * packet that fails validation should fail the emit rather than silently propagating
   * malformed data").
   */
  emit: (type: string, packet: unknown) => Promise<EventRow>;
  /**
   * The task's declared emit types with their compiled schemas, for executors that
   * synthesize output — the StubExecutor's scriptless mode emits one valid sample of each.
   */
  declaredEmits: () => Promise<Array<{ type: string; schema: Record<string, unknown> }>>;
};

/** Registry is a plain object on purpose: no factory, no DI container. */
export type ExecutorRegistry = Record<string, TaskExecutor>;

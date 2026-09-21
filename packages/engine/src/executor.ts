import type { Db, EventRow, RunRow, TaskRow } from "@tabductor/db";

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
export type RunResult = { ok: true; result?: unknown } | { ok: false; error: string; permanent?: boolean; suspended?: boolean; deferred?: boolean };

/** Everything an executor is allowed to see, plus the one thing it may do to the world. */
export type RunHandle = {
  run: RunRow;
  task: TaskRow;
  /** `null` for a run with no trigger (a schedule fire in S2b, or a manual start). */
  trigger: EventRow | null;
  /** Aborted when cancellation, timeout, or a newer engine generation revokes ownership. */
  signal: AbortSignal;
  recordOutcome?: (outcome: import("./record-progress.js").RecordOutcome) => Promise<void>;
  recordCompletionError?: () => Promise<string | null>;
  destination?: {
    role: import("./intent-contract.js").HarnessTask["role"];
    read: (id?: string) => Promise<import("./destination-contracts.js").StoredDestination>;
    publish: (mapping: import("./destination-contracts.js").DestinationMapping, evidence: import("./destination-contracts.js").DestinationEvidence) => Promise<import("./destination-contracts.js").StoredDestination>;
  };
  requestHumanAction?: (input: { reason: string; resumeWhen: string }) => Promise<void>;
  /**
   * Validates `packet` against the event's compiled schema for this task's workflow
   * version and, if it passes, publishes through the outbox in one transaction. Rejects on
   * a schema violation — the executor is expected to let that failure end the run (§4: "a
   * packet that fails validation should fail the emit rather than silently propagating
   * malformed data").
   *
   * `opts.withTx` (S5g, graph-compilation-llm §7's ordering rule): runs *inside the same
   * transaction* as the publish, before it — the hook that lets a decision executor
   * commit a staged `store.insert`/`upsert` atomically with the `emit` that follows it
   * ("the store write + THIS emit commit atomically", `packages/store`'s own doc comment).
   * `undefined` for every executor that has no side effect to fold in, which is every
   * browser executor — `emitFromRun`'s own
   * implementation is a no-op wrapper when this is absent, so nothing about the plain emit
   * path changes shape or cost.
   */
  emit: (
    type: string,
    packet: unknown,
    opts?: { withTx?: (trx: Db) => Promise<void>; dedupeKey?: string },
  ) => Promise<EventRow | null>;
  /**
   * The task's declared emit types with their compiled schemas, for executors that
   * synthesize output — the StubExecutor's scriptless mode emits one valid sample of each.
   */
  declaredEmits: () => Promise<Array<{ type: string; schema: Record<string, unknown> }>>;
};

/** Registry is a plain object on purpose: no factory, no DI container. Keyed by `executorKey`. */
export type ExecutorRegistry = Record<string, TaskExecutor>;

/**
 * The registry's lookup key (S5a, techical_plan §4: "the tool registry is a function of
 * `(kind, mode)`, not of `kind` alone"). One function so every registration site and the
 * one dispatch site agree on the same string — `":"` is not legal in either `kind` (a
 * closed domain) or `mode` (open, but always a bare identifier), so it cannot collide.
 */
export function executorKey(kind: string, mode: string): string {
  return `${kind}:${mode}`;
}

/**
 * A completed execution, as the compiler reads it.
 *
 * The old pipeline filtered the trace down to a "structural" subsequence *before* the model
 * ever saw it — failed actions dropped, `perceive` dropped, anything not on a fixed allowlist
 * dropped — and then required two runs to have produced the identical remainder. That is the
 * wrong shape for the job: `trace-compilation.md` asks the compiler to *separate DOM
 * exploration from the actual work*, and a filter that has already thrown the exploration away
 * has also thrown away the evidence that an inspection supplied data the work depends on.
 *
 * So nothing is dropped here. This module turns trace rows into a faithful, readable account
 * of one execution — every action in order, successful and failed, exploratory and load-bearing
 * — plus the aggregates (selectors seen, navigations reached, event types emitted) that
 * `plan.ts` grounds the model's interpretation against afterwards. Interpretation is the LLM's;
 * grounding is deterministic; this file is neither, it is only the reading.
 *
 * What is *not* here is page content: `queryAll` records a row count and its field names, never
 * the values, and `perceive` records counts (§14 — page content is an opt-in storage category,
 * and the trace is not where it is opted into). The compiler therefore cannot hard-code what a
 * run happened to see even if it tried, which is the property the "do not bake in the example
 * posts" rule needs in order to be structural rather than an instruction the model may ignore.
 */

/** One `trace_entries` row, as the caller loaded it. */
export type TraceEntry = { seq: number; kind: string; payload: Record<string, unknown> };

/** One completed run's trace. Loading rows into this shape is `traces.ts`'s one job, so a
 * production caller and a test hand-building entries feed the identical pipeline. */
export type RunTrace = { runId: string; entries: TraceEntry[] };

/** One recorded action, flattened out of `payload` with its interesting fields named. */
export type ActionEvidence = {
  seq: number;
  action: string;
  ok: boolean;
  selector?: string;
  url?: string;
  fields?: string[];
  /** `queryAll`'s row count — how much data the page actually had. */
  count?: number;
  direction?: string;
  timeout?: number;
  durationMs?: number;
  /** `emit` only. */
  type?: string;
  dedupeKey?: string | null;
  deduped?: boolean;
  error?: string;
};

export type ExtractionEvidence = { selector: string; fields: string[]; rows: number };

export type EmitEvidence = { type: string; count: number; dedupeKeyed: boolean };

export type RunEvidence = {
  runId: string;
  /** Every navigation the gate allowed, in order, including redirects. */
  navigations: string[];
  /** Every action, in order — nothing filtered. */
  actions: ActionEvidence[];
  /** Successful `queryAll` calls that asked for fields, merged per (selector, fields). */
  extractions: ExtractionEvidence[];
  /** Event types this run published, with whether a dedupe key rode along. */
  emits: EmitEvidence[];
  /** Selectors this run addressed at all — the vocabulary a plan may draw on. */
  selectors: string[];
  /** How much the agent looked around: `perceive` calls and failed actions. */
  observations: number;
  failedActions: number;
  /** Model turns. Zero means this trace came from a compiled run. */
  llmSteps: number;
  deopted: boolean;
  recovered: boolean;
  policyDenials: { check: string; rule: string }[];
};

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function actionOf(entry: TraceEntry): ActionEvidence | null {
  const action = str(entry.payload.action);
  if (action === undefined) return null;
  const fields = entry.payload.fields;
  return {
    seq: entry.seq,
    action,
    ok: entry.payload.ok !== false,
    ...(str(entry.payload.selector) !== undefined ? { selector: str(entry.payload.selector)! } : {}),
    ...(str(entry.payload.url) !== undefined ? { url: str(entry.payload.url)! } : {}),
    ...(Array.isArray(fields) ? { fields: fields.map(String) } : {}),
    ...(num(entry.payload.count) !== undefined ? { count: num(entry.payload.count)! } : {}),
    ...(str(entry.payload.direction) !== undefined ? { direction: str(entry.payload.direction)! } : {}),
    ...(num(entry.payload.timeout) !== undefined ? { timeout: num(entry.payload.timeout)! } : {}),
    ...(num(entry.payload.duration_ms) !== undefined ? { durationMs: num(entry.payload.duration_ms)! } : {}),
    ...(str(entry.payload.type) !== undefined ? { type: str(entry.payload.type)! } : {}),
    ...(action === "emit" ? { dedupeKey: str(entry.payload.dedupeKey) ?? null } : {}),
    ...(entry.payload.deduped === true ? { deduped: true } : {}),
    ...(str(entry.payload.error) !== undefined ? { error: str(entry.payload.error)! } : {}),
  };
}

export function buildEvidence(trace: RunTrace): RunEvidence {
  const entries = [...trace.entries].sort((a, b) => a.seq - b.seq);
  const actions: ActionEvidence[] = [];
  const navigations: string[] = [];
  const policyDenials: { check: string; rule: string }[] = [];
  const extractions = new Map<string, ExtractionEvidence>();
  const emits = new Map<string, EmitEvidence>();
  const selectors = new Set<string>();
  let llmSteps = 0;
  let observations = 0;
  let failedActions = 0;
  let deopted = false;
  let recovered = false;

  for (const entry of entries) {
    if (entry.kind === "navigation") {
      const url = str(entry.payload.url);
      if (url !== undefined) navigations.push(url);
      continue;
    }
    if (entry.kind === "llm") {
      llmSteps++;
      continue;
    }
    if (entry.kind === "policy_denied") {
      policyDenials.push({ check: str(entry.payload.check) ?? "?", rule: str(entry.payload.rule) ?? "?" });
      continue;
    }
    if (entry.kind !== "action") continue;

    const action = actionOf(entry);
    if (!action) continue;
    actions.push(action);
    if (!action.ok) failedActions++;
    if (action.action === "perceive") observations++;
    if (action.action === "deopt") deopted = true;
    if (action.action === "deopt_recovery") recovered = true;
    if (action.selector !== undefined && action.selector !== "") selectors.add(action.selector);

    if (action.action === "queryAll" && action.ok && (action.fields?.length ?? 0) > 0) {
      const key = `${action.selector ?? ""}::${[...(action.fields ?? [])].sort().join(",")}`;
      const prior = extractions.get(key);
      const rows = action.count ?? 0;
      if (prior) prior.rows = Math.max(prior.rows, rows);
      else extractions.set(key, { selector: action.selector ?? "", fields: action.fields ?? [], rows });
    }

    if (action.action === "emit" && action.ok && action.type !== undefined) {
      const prior = emits.get(action.type) ?? { type: action.type, count: 0, dedupeKeyed: false };
      prior.count++;
      prior.dedupeKeyed ||= action.dedupeKey !== null && action.dedupeKey !== undefined;
      emits.set(action.type, prior);
    }
  }

  return {
    runId: trace.runId,
    navigations,
    actions,
    extractions: [...extractions.values()],
    emits: [...emits.values()].sort((a, b) => (a.type < b.type ? -1 : 1)),
    selectors: [...selectors].sort(),
    observations,
    failedActions,
    llmSteps,
    deopted,
    recovered,
    policyDenials,
  };
}

/**
 * Compilation needs to have *seen* the work. A task whose storage flags turned actions off
 * leaves a trace that says a run happened and nothing about what it did; the compiler must
 * refuse rather than invent the missing half (`trace-compilation.md`: "the compiler must not
 * invent the missing work").
 */
export function missingEvidence(evidence: RunEvidence): string | null {
  if (evidence.actions.length === 0) {
    return `run ${evidence.runId} recorded no actions — compilation needs an action trace (limits_json.storage.actions)`;
  }
  if (evidence.navigations.length === 0 && !evidence.actions.some((a) => a.action === "goto")) {
    return `run ${evidence.runId} recorded no navigation — compilation needs to know where the work happens`;
  }
  return null;
}

/** One action as the model reads it: enough to judge whether it was work or looking around. */
function renderAction(action: ActionEvidence): string {
  const parts = [`#${action.seq}`, action.action];
  if (action.url !== undefined) parts.push(JSON.stringify(action.url));
  if (action.selector !== undefined) parts.push(JSON.stringify(action.selector));
  if (action.direction !== undefined) parts.push(action.direction);
  if (action.fields !== undefined) parts.push(`fields=[${action.fields.join(",")}]`);
  if (action.count !== undefined) parts.push(`rows=${action.count}`);
  if (action.type !== undefined) parts.push(`type=${action.type}`);
  if (action.dedupeKey !== undefined) parts.push(`dedupeKey=${action.dedupeKey === null ? "none" : "yes"}`);
  if (action.deduped) parts.push("deduped");
  if (action.timeout !== undefined) parts.push(`timeout=${action.timeout}ms`);
  if (action.durationMs !== undefined) parts.push(`took=${action.durationMs}ms`);
  if (!action.ok) parts.push(`FAILED: ${action.error ?? "no reason recorded"}`);
  return `  ${parts.join(" ")}`;
}

/** The whole execution, in order, as text for the distillation prompt. */
export function renderEvidence(evidence: RunEvidence, label: string): string {
  return [
    `--- ${label}: run ${evidence.runId} ---`,
    `Navigations (in order): ${evidence.navigations.join(" -> ") || "(none)"}`,
    `Model turns: ${evidence.llmSteps}; page observations: ${evidence.observations}; failed actions: ${evidence.failedActions}`,
    ...(evidence.deopted ? [`This run began as a compiled script whose guards failed; the agent recovered it.`] : []),
    `Actions, every one, in order:`,
    ...evidence.actions.map(renderAction),
    `Extractions that returned data: ${
      evidence.extractions.map((e) => `${JSON.stringify(e.selector)} fields [${e.fields.join(",")}] -> ${e.rows} rows`).join("; ") || "(none)"
    }`,
    `Events published: ${
      evidence.emits.map((e) => `${e.type} x${e.count}${e.dedupeKeyed ? " (with dedupe key)" : " (no dedupe key)"}`).join("; ") || "(none)"
    }`,
    ...(evidence.policyDenials.length > 0
      ? [`Policy denials: ${evidence.policyDenials.map((d) => `${d.check}/${d.rule}`).join(", ")}`]
      : []),
  ].join("\n");
}

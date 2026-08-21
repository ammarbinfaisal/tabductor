/**
 * Does this task do the same thing every time?
 *
 * Compilation is only sound when the answer is yes, and K=2 is the threshold §11 sets: one
 * trace overfits — an A/B variant, a one-time cookie banner, a promoted tweet that happened to
 * be there — and two agreeing traces are the cheapest evidence that the path is the task
 * rather than the day. The checker is what turns "these runs looked similar" into a specific,
 * mechanical claim, and its failure reason is what a human reads when a task refuses to
 * compile.
 *
 * Pure functions over trace data. No database access: callers load the traces, which is what
 * keeps this testable against hand-written entries and keeps the compiler from growing a
 * second, divergent idea of what a trace is.
 *
 * **Deviation from the spec, recorded.** §11 asks the checker to compare "strategy + selector
 * as recorded in the trace". Strategy is not in the trace and never was: `LocatorStrategy`
 * lives on `AnchoredElement` inside the agent's perception, `summarizePerception` strips it,
 * and `RunSession` is handed an already-resolved selector string — so `act()` records
 * `{selector}` and nothing about how it was chosen. Matching is therefore on the resolved
 * selector alone. That is the right invariant anyway: the compiled script uses the selector,
 * so the selector is what has to be stable. Threading strategy down would mean changing S4b's
 * tool surface to carry it into every session call, for information no emitted script reads.
 */

/** One `trace_entries` row, as the caller loaded it. */
export type TraceEntry = { seq: number; kind: string; payload: Record<string, unknown> };
export type RunTrace = { runId: string; entries: TraceEntry[] };

/** The structural steps a script has to reproduce. Non-structural actions — `emit`, agent
 * bookkeeping, screenshots — are deliberately not steps: two runs that emit the same events
 * after the same navigations and actions are consistent whether or not one took a screenshot. */
export type Step =
  | { op: "goto"; target: string }
  | { op: "click"; target: string }
  | { op: "type"; target: string }
  | { op: "waitFor"; target: string; timeout?: number }
  | { op: "upload"; target: string }
  | { op: "scroll"; target: string }
  | { op: "queryAll"; target: string; fields: string[] };

export type Anchor = { step: number; op: Step["op"]; selector: string };
export type Extraction = { step: number; selector: string; fields: string[] };

export type ConsistencyReport =
  | {
      consistent: true;
      /** One per structural step, in order — the skeleton the compiler writes against. */
      anchors: Anchor[];
      /** Max observed wait per step index, so a compiled guard is not tighter than reality. */
      waits: Record<number, number>;
      extractions: Extraction[];
      /** Event types every trace emitted, sorted. */
      emits: string[];
      navigations: string[];
      fromRuns: string[];
    }
  | { consistent: false; reason: string };

const STRUCTURAL = new Set(["goto", "click", "type", "waitFor", "upload", "scroll", "queryAll"]);

function stepsOf(trace: RunTrace): Step[] {
  const steps: Step[] = [];
  for (const entry of [...trace.entries].sort((a, b) => a.seq - b.seq)) {
    if (entry.kind !== "action") continue;
    const action = entry.payload.action;
    if (typeof action !== "string" || !STRUCTURAL.has(action)) continue;
    // A failed action is not part of the path a script should reproduce — the agent recovered
    // from it, and compiling the recovery attempt as if it were the plan is how a script
    // learns to do the wrong thing reliably.
    if (entry.payload.ok === false) continue;

    const target = action === "goto" ? String(entry.payload.url ?? "") : String(entry.payload.selector ?? "");
    if (action === "queryAll") {
      steps.push({ op: "queryAll", target, fields: (entry.payload.fields as string[]) ?? [] });
    } else if (action === "waitFor") {
      const timeout = entry.payload.timeout;
      steps.push({ op: "waitFor", target, ...(typeof timeout === "number" ? { timeout } : {}) });
    } else if (action === "scroll") {
      steps.push({ op: "scroll", target: String(entry.payload.direction ?? "") });
    } else {
      steps.push({ op: action as "click" | "type" | "upload" | "goto", target });
    }
  }
  return steps;
}

function navigationsOf(trace: RunTrace): string[] {
  return [...trace.entries]
    .sort((a, b) => a.seq - b.seq)
    .filter((e) => e.kind === "navigation")
    .map((e) => String(e.payload.url ?? ""));
}

function emitsOf(trace: RunTrace): string[] {
  return [
    ...new Set(
      trace.entries
        .filter((e) => e.kind === "action" && e.payload.action === "emit" && e.payload.ok !== false)
        .map((e) => String(e.payload.type ?? "")),
    ),
  ].sort();
}

/** Durations, so a compiled `waitFor` is never tighter than what the traces actually needed. */
function waitsOf(trace: RunTrace): Record<number, number> {
  const waits: Record<number, number> = {};
  let index = -1;
  for (const entry of [...trace.entries].sort((a, b) => a.seq - b.seq)) {
    if (entry.kind !== "action") continue;
    const action = entry.payload.action;
    if (typeof action !== "string" || !STRUCTURAL.has(action) || entry.payload.ok === false) continue;
    index++;
    const observed = entry.payload.timeout ?? entry.payload.duration_ms;
    if (typeof observed === "number") waits[index] = observed;
  }
  return waits;
}

export function checkConsistency(traces: RunTrace[]): ConsistencyReport {
  if (traces.length < 2) {
    return { consistent: false, reason: `need at least 2 traces to compile, got ${traces.length}` };
  }

  const perTrace = traces.map((t) => ({
    runId: t.runId,
    steps: stepsOf(t),
    navigations: navigationsOf(t),
    emits: emitsOf(t),
    waits: waitsOf(t),
  }));

  // Sorted so the report does not depend on the order the caller happened to load runs in;
  // the comparison itself is symmetric, and a test asserts that.
  const [first, ...rest] = [...perTrace].sort((a, b) => (a.runId < b.runId ? -1 : 1));
  if (!first) return { consistent: false, reason: "no traces" };

  for (const other of rest) {
    if (other.steps.length !== first.steps.length) {
      return {
        consistent: false,
        reason: `step count diverged: ${first.runId} took ${first.steps.length} steps, ${other.runId} took ${other.steps.length}`,
      };
    }
    for (const [i, step] of first.steps.entries()) {
      const theirs = other.steps[i]!;
      if (step.op !== theirs.op) {
        return {
          consistent: false,
          reason: `step ${i + 1} action diverged: ${step.op} vs ${theirs.op}`,
        };
      }
      if (step.target !== theirs.target) {
        return {
          consistent: false,
          reason: `step ${i + 1} locator diverged: "${step.target}" vs "${theirs.target}"`,
        };
      }
      if (step.op === "queryAll" && theirs.op === "queryAll") {
        const a = [...step.fields].sort().join(",");
        const b = [...theirs.fields].sort().join(",");
        if (a !== b) {
          return { consistent: false, reason: `step ${i + 1} extraction fields diverged: [${a}] vs [${b}]` };
        }
      }
    }
    if (first.navigations.join("|") !== other.navigations.join("|")) {
      return {
        consistent: false,
        reason: `navigation sequence diverged: ${first.navigations.join(" -> ")} vs ${other.navigations.join(" -> ")}`,
      };
    }
    if (first.emits.join(",") !== other.emits.join(",")) {
      return {
        consistent: false,
        reason: `emitted event types diverged: [${first.emits.join(",")}] vs [${other.emits.join(",")}]`,
      };
    }
  }

  const waits: Record<number, number> = {};
  for (const trace of perTrace) {
    for (const [index, value] of Object.entries(trace.waits)) {
      const key = Number(index);
      waits[key] = Math.max(waits[key] ?? 0, value);
    }
  }

  return {
    consistent: true,
    anchors: first.steps.map((step, i) => ({ step: i, op: step.op, selector: step.target })),
    waits,
    extractions: first.steps
      .map((step, i) => (step.op === "queryAll" ? { step: i, selector: step.target, fields: step.fields } : null))
      .filter((x): x is Extraction => x !== null),
    emits: first.emits,
    navigations: first.navigations,
    fromRuns: [...perTrace.map((t) => t.runId)].sort(),
  };
}

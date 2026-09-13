import { z } from "zod";
import type { RunEvidence } from "./evidence.js";

/**
 * The work, separated from the looking around.
 *
 * This is the artifact `trace-compilation.md` asks for between the trace and the script: an
 * explicit statement of *what the script must reproduce*, proposed by the model and then
 * checked, mechanically, against the evidence it claims to have read. "The LLM proposes the
 * interpretation; deterministic validation remains the gatekeeper" is a division of labour
 * that only exists if the interpretation is a data structure someone can check — a model that
 * emits JavaScript directly has already smuggled its interpretation past every gate except
 * the lint parser, which has no opinion about whether the script does the right work.
 *
 * Two things the plan makes checkable that raw source does not:
 *
 * 1. **Grounding.** Every URL, every event type and every selector the script *acts on* has to
 *    appear in the evidence. A model that invents a button to click, or decides to visit a page
 *    the run never visited, is caught here rather than at 3am on a live page. Selectors the
 *    script only *reads* may generalise — an agent walks a list anchor by anchor and a script
 *    should address the list — but only under a guard that turns a wrong generalisation into a
 *    deopt.
 * 2. **Nothing dropped.** Every event type the source run actually published has to be in the
 *    plan. Exploration may be discarded; work may not.
 *
 * `discarded` is the other half of the same claim, and the reason it is a required field: the
 * model has to say what it threw away and why, which is both the audit trail for a refusal and
 * the thing a human reads when a script turns out to have skipped a step that mattered.
 */

const guardSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), pattern: z.string().min(1) }),
  z.object({ kind: z.literal("exists"), selector: z.string().min(1), timeoutMs: z.number().int().positive().optional() }),
  z.object({ kind: z.literal("noDialog") }),
]);

const fieldSchema = z.object({
  name: z.string().min(1),
  /** Relative selector inside the extracted row; absent means the row element itself. */
  selector: z.string().optional(),
  /** Attribute to read instead of text. */
  attr: z.string().optional(),
});

const stepSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("goto"), url: z.string().min(1), why: z.string().min(1) }),
  z.object({
    op: z.literal("waitFor"),
    selector: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
    why: z.string().min(1),
  }),
  z.object({ op: z.literal("click"), selector: z.string().min(1), why: z.string().min(1) }),
  z.object({
    op: z.literal("type"),
    selector: z.string().min(1),
    /** Where the text comes from — a literal the task defines, or a field of the trigger. */
    source: z.string().min(1),
    why: z.string().min(1),
  }),
  z.object({ op: z.literal("scroll"), direction: z.enum(["up", "down"]), why: z.string().min(1) }),
  z.object({
    op: z.literal("extract"),
    selector: z.string().min(1),
    fields: z.array(fieldSchema).min(1),
    /** The name this extraction is referred to by in a later `emit` step. */
    as: z.string().min(1),
    why: z.string().min(1),
  }),
  z.object({
    op: z.literal("emit"),
    eventType: z.string().min(1),
    /** The `extract` step's `as` whose rows are emitted, one event each. */
    from: z.string().min(1),
    /** Which field of a row makes the dedupe key. Emitting without one is not idempotent. */
    dedupeField: z.string().min(1),
    why: z.string().min(1),
  }),
]);

export const workPlanSchema = z.object({
  /** The task's goal in the compiler's own words — it becomes the deopt recovery prompt's first half. */
  goal: z.string().min(1),
  guards: z.array(guardSchema).min(1),
  steps: z.array(stepSchema).min(1),
  /** What the agent did that the script must NOT repeat, and why it was not work. */
  discarded: z.array(z.object({ what: z.string().min(1), why: z.string().min(1) })),
  /** What a live agent wakes up to when the guards fail mid-run. */
  recoveryPrompt: z.string().min(20),
});

export type WorkPlan = z.infer<typeof workPlanSchema>;
export type PlanStep = z.infer<typeof stepSchema>;

export type PlanCheck = { ok: true } | { ok: false; reason: string };

/** Same page, ignoring the query string — a cursor or a cache-buster in the URL the agent
 * happened to land on must not make an otherwise identical navigation "ungrounded". */
function samePage(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.origin === right.origin && left.pathname === right.pathname;
  } catch {
    return false;
  }
}

function selectorsOf(evidence: RunEvidence[]): Set<string> {
  const all = new Set<string>();
  for (const run of evidence) {
    for (const selector of run.selectors) all.add(selector);
    for (const extraction of run.extractions) all.add(extraction.selector);
  }
  return all;
}

/**
 * The gate. `source` is the run that made the task eligible; `supporting` are other traces
 * that happened to be available, which may widen what counts as grounded but may not remove
 * anything the source run did.
 *
 * Cross-trace comparison is deliberately *of the distilled work*, not of step sequences
 * (`trace-compilation.md`: "different discovery paths can implement the same task"): a
 * supporting run that published an event type the plan does not is a real divergence and
 * refuses; a supporting run that clicked through three extra menus is not.
 */
export function validatePlan(
  plan: WorkPlan,
  input: { source: RunEvidence; supporting: RunEvidence[]; declaredEmits: string[] },
): PlanCheck {
  const evidence = [input.source, ...input.supporting];
  const selectors = selectorsOf(evidence);
  const navigations = evidence.flatMap((run) => run.navigations);
  const guarded = new Set(plan.guards.flatMap((g) => (g.kind === "exists" ? [g.selector] : [])));
  const extractNames = new Set<string>();

  for (const [i, step] of plan.steps.entries()) {
    const at = `step ${i + 1} (${step.op})`;
    switch (step.op) {
      case "goto":
        if (!navigations.some((url) => samePage(url, step.url))) {
          return { ok: false, reason: `${at} navigates to ${step.url}, which no trace ever reached` };
        }
        break;
      case "click":
      case "type":
        // Strict: these change the page. A click on a selector no run ever addressed is a
        // guess about what a button does, made by something that cannot undo it.
        if (!selectors.has(step.selector)) {
          return { ok: false, reason: `${at} uses selector ${JSON.stringify(step.selector)}, which no trace addressed` };
        }
        break;
      case "waitFor":
      case "extract": {
        // Softer, deliberately (see `guarded` below). An agent walks a list one anchor at a
        // time — `:nth-match(a:text-is("permalink"), 2)` — and a script that could only
        // re-address those exact anchors would be the over-fitted replay the contract forbids.
        // Generalising to the collection they came from is the job. What is *not* allowed is
        // generalising silently: an unobserved selector must be one the script's own guards
        // assert, so a wrong assumption deopts to the agent instead of quietly emitting nothing.
        if (!selectors.has(step.selector) && !guarded.has(step.selector)) {
          return {
            ok: false,
            reason: `${at} uses selector ${JSON.stringify(step.selector)}, which no trace addressed and no guard asserts`,
          };
        }
        if (step.op === "extract") extractNames.add(step.as);
        break;
      }
      case "emit": {
        if (!input.declaredEmits.includes(step.eventType)) {
          return { ok: false, reason: `${at} publishes "${step.eventType}", which this task does not declare emitting` };
        }
        if (!extractNames.has(step.from)) {
          return { ok: false, reason: `${at} emits from "${step.from}", which no earlier extract step produced` };
        }
        const producer = plan.steps.find(
          (s): s is Extract<PlanStep, { op: "extract" }> => s.op === "extract" && s.as === step.from,
        );
        if (producer && !producer.fields.some((f) => f.name === step.dedupeField)) {
          return {
            ok: false,
            reason: `${at} dedupes on "${step.dedupeField}", which "${step.from}" does not extract`,
          };
        }
        break;
      }
      case "scroll":
        break;
    }
  }

  for (const guard of plan.guards) {
    // An `exists` guard needs no grounding of its own: it is a *question*, and the answer
    // "no" is the deopt door opening, which is the safe outcome by construction. A `url`
    // guard does — a pattern that matches nothing the traces reached would fail every run.
    if (guard.kind === "url" && !navigations.some((url) => new RegExp(guard.pattern).test(url))) {
      return { ok: false, reason: `guard url(${guard.pattern}) matches none of the URLs the traces reached` };
    }
  }

  if (!plan.guards.some((g) => g.kind === "url" || g.kind === "exists")) {
    return { ok: false, reason: "the plan has no url or exists guard — a script with nothing to verify can never deopt" };
  }

  // Nothing the runs actually did may be dropped. Checked against every trace, not just the
  // source: a supporting run that emitted a type this plan ignores means the two runs did
  // different work, which is the divergence that matters.
  const planned = new Set(plan.steps.filter((s) => s.op === "emit").map((s) => s.eventType));
  for (const run of evidence) {
    for (const emitted of run.emits) {
      if (!planned.has(emitted.type)) {
        return {
          ok: false,
          reason: `run ${run.runId} published "${emitted.type}" and the plan never emits it`,
        };
      }
    }
  }

  if (input.source.emits.length > 0 && !plan.steps.some((s) => s.op === "emit")) {
    return { ok: false, reason: "the source run published events and the plan emits none" };
  }

  return { ok: true };
}

/** The plan as the script-writing turn reads it back. */
export function renderPlan(plan: WorkPlan): string {
  return [
    `Goal: ${plan.goal}`,
    ``,
    `Guards (all must hold before the work begins):`,
    ...plan.guards.map((g) =>
      g.kind === "url"
        ? `  - url matches /${g.pattern}/`
        : g.kind === "exists"
          ? `  - exists ${JSON.stringify(g.selector)}${g.timeoutMs ? ` (wait up to ${g.timeoutMs}ms)` : ""}`
          : `  - no dialog has interrupted the page`,
    ),
    ``,
    `Steps, in order:`,
    ...plan.steps.map((step, i) => `  ${i + 1}. ${JSON.stringify(step)}`),
    ``,
    `Deliberately not reproduced (the agent's exploration):`,
    ...(plan.discarded.length > 0 ? plan.discarded.map((d) => `  - ${d.what}: ${d.why}`) : ["  (nothing)"]),
    ``,
    `Recovery prompt to hand a live agent when the guards fail:`,
    plan.recoveryPrompt,
  ].join("\n");
}

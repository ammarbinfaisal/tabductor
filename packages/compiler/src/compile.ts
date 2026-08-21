import { tasks, type CompiledScriptRow, type Db } from "@tabductor/db";
import type { Metrics } from "@tabductor/telemetry";
import { runCompiledScript, type CtxHost } from "@tabductor/static-rt";
import { eq } from "drizzle-orm";
import { checkConsistency, type ConsistencyReport, type RunTrace } from "./consistency.js";
import { lintScript } from "./lint.js";
import { insertCandidateScript } from "./registry.js";

/**
 * Traces in, a `candidate` script out — or a descriptive refusal and no row.
 *
 * One function composing pieces that already exist (the S4a `Llm` adapter, S6a's lint gate and
 * isolate, the registry). No `CompilerService`: there is one caller and one path.
 *
 * The order of the validation pipeline is the substance of this subphase. A model wrote the
 * code, so nothing it produced is trusted until it has passed a parser that refuses the shapes
 * a script must never contain, and then actually *run* in the same cage it will run in later.
 * Only then is a row written. A pipeline that stored first and validated on read would put the
 * burden on every future reader to remember.
 */

/** Only what this function needs, injected — the same shape every executor here follows. */
export type Llm = {
  complete(req: {
    system: string;
    messages: { role: "user" | "assistant"; content: string }[];
    tools: never[];
  }): Promise<{ text?: string }>;
};

export type CompileDeps = {
  db: Db;
  llm: Llm;
  /**
   * Where a candidate is dry-run before it is stored. A factory rather than a value because a
   * dry run may not reuse a session a previous attempt left mid-page.
   */
  dryRunHost: () => Promise<CtxHost>;
  metrics?: Metrics;
  /** Retry budget for a model that returns something the gate rejects. */
  maxAttempts?: number;
};

export type CompileResult =
  | { ok: true; script: CompiledScriptRow; report: ConsistencyReport & { consistent: true } }
  | { ok: false; stage: "kind" | "consistency" | "llm" | "lint" | "dry_run"; error: string };

/**
 * `kind='browser'` only, and written as an allowlist on purpose.
 *
 * `decision` joins this list when `ctx.store` lands in the static runtime
 * (graph-compilation-llm §2.4) — it is a "not yet", not a "never", and writing the filter as
 * `!== 'asset'` would have silently admitted it the day the kind was added. `asset` is the
 * permanent exclusion: MCP results and LLM prose have no stable structure for a guard to
 * assert on, so a "compiled" asset script would be a compiler that only pretends to be one.
 */
const COMPILABLE_KINDS = new Set(["browser"]);

const SYSTEM_PROMPT = `You compile browser automation traces into a single static JavaScript module.

Emit ONLY JavaScript source. No markdown fences, no prose, no explanation.

The module must be exactly:

export default async function run(ctx) { ... }

Rules, all of them binding:
- \`ctx\` is the ONLY thing in scope. There is no fetch, no require, no process, no timers.
- Never use eval, new Function, import, or with. Never call anything that is not a ctx.* method.
- Begin with a GUARD BLOCK: build an array of ctx.guard.url / ctx.guard.exists / ctx.guard.noDialog
  checks distilled from what every trace saw, then:
      if (!(await ctx.guard.all(guards))) {
        return ctx.deopt(<recovery prompt>, { failed: await ctx.guard.failures() });
      }
  The recovery prompt must restate the task's goal and the shape of the events it emits — it is
  what a live agent wakes up to mid-run when the guards fail, and it is all the context it gets.
- Drive the page with ctx.page.goto / click / type / scroll / waitFor only.
- Extract declaratively with ctx.page.evalExtract(selector, fields), where fields is an object
  like { text: { selector: "p" }, url: { selector: "a", attr: "href" } }. There is no page.evaluate.
- Emit with ctx.emitIfNew(type, packet, { dedupeKey }) so a re-run is idempotent.
- Use ctx.state.get / ctx.state.set for cursors that must survive between runs.
- If an extraction returns zero rows where every trace saw data, ctx.deopt rather than emit nothing.`;

function userPrompt(report: ConsistencyReport & { consistent: true }, prompt: string | null): string {
  return [
    `Task goal (the author's own words):`,
    prompt ?? "(none recorded)",
    ``,
    `Every one of these runs did the same thing. Compile that into one script.`,
    ``,
    `Navigations, in order:`,
    ...report.navigations.map((url, i) => `  ${i + 1}. ${url}`),
    ``,
    `Steps, in order (op, resolved selector, max wait observed in ms):`,
    ...report.anchors.map((a) => `  ${a.step + 1}. ${a.op} ${JSON.stringify(a.selector)} ${report.waits[a.step] ?? ""}`),
    ``,
    `Extractions:`,
    ...report.extractions.map((e) => `  step ${e.step + 1}: ${JSON.stringify(e.selector)} fields ${JSON.stringify(e.fields)}`),
    ``,
    `Event types emitted: ${report.emits.join(", ") || "(none)"}`,
    ``,
    `Compiled from runs: ${report.fromRuns.join(", ")}`,
  ].join("\n");
}

/** Models wrap code in fences however often you ask them not to. */
function stripFences(text: string): string {
  const fenced = /```(?:js|javascript)?\n([\s\S]*?)```/.exec(text);
  return (fenced?.[1] ?? text).trim();
}

export async function compileTask(
  deps: CompileDeps,
  taskId: string,
  traces: RunTrace[],
): Promise<CompileResult> {
  const started = Date.now();
  let outcome: "ok" | "kind" | "consistency" | "llm" | "lint" | "dry_run" = "ok";
  try {
    const [task] = await deps.db.select().from(tasks).where(eq(tasks.id, taskId));
    if (!task) return (outcome = "kind"), { ok: false, stage: "kind", error: `no task ${taskId}` };
    if (!COMPILABLE_KINDS.has(task.kind)) {
      outcome = "kind";
      return { ok: false, stage: "kind", error: `kind "${task.kind}" is not compiled` };
    }

    const report = checkConsistency(traces);
    if (!report.consistent) {
      outcome = "consistency";
      return { ok: false, stage: "consistency", error: report.reason };
    }

    const attempts = deps.maxAttempts ?? 2;
    let lastError = "no attempt was made";
    for (let attempt = 0; attempt < attempts; attempt++) {
      const messages: { role: "user" | "assistant"; content: string }[] = [
        { role: "user", content: userPrompt(report, task.prompt) },
      ];
      if (attempt > 0) {
        // The gate's own words, verbatim — the same "hand the failure back unchanged" shape
        // S5e uses for a TeX log. A paraphrase is a second chance to lose the detail.
        messages.push({ role: "user", content: `Your previous attempt was rejected:\n${lastError}\nEmit a corrected module.` });
      }

      const response = await deps.llm.complete({ system: SYSTEM_PROMPT, messages, tools: [] });
      const source = stripFences(response.text ?? "");
      if (source === "") {
        lastError = "the model returned no source";
        outcome = "llm";
        continue;
      }

      const lint = lintScript(source);
      if (!lint.ok) {
        for (const v of lint.violations) deps.metrics?.scriptLintRejected.add({ rule: v.rule });
        lastError = lint.violations.map((v) => `line ${v.line}: ${v.rule} — ${v.message}`).join("\n");
        outcome = "lint";
        continue;
      }

      // Run it in the cage it will live in. A script that throws on the very traces it was
      // compiled from is not a candidate; one that deopts cleanly is (the guards did their
      // job, which is a working script meeting a page it was not compiled for).
      const host = await deps.dryRunHost();
      const dry = await runCompiledScript(source, host, { metrics: deps.metrics });
      if (dry.outcome === "error" || dry.outcome === "killed") {
        lastError =
          dry.outcome === "error" ? `dry run threw: ${dry.error}` : `dry run was killed: ${dry.reason}`;
        outcome = "dry_run";
        continue;
      }

      const script = await insertCandidateScript(deps.db, {
        taskId,
        source,
        guardsMeta: { anchors: report.anchors, waits: report.waits, emits: report.emits },
        fromRuns: report.fromRuns,
      });
      outcome = "ok";
      return { ok: true, script, report };
    }

    return { ok: false, stage: outcome === "ok" ? "llm" : outcome, error: lastError };
  } finally {
    deps.metrics?.compileRuns.add({ outcome });
    deps.metrics?.compileDuration.record((Date.now() - started) / 1000, { outcome });
  }
}

import type { RunTrace } from "./evidence.js";
import type { WorkPlan } from "./plan.js";
import { compileSdkTask } from "./sdk-compile.js";
import type { SdkPlan } from "./sdk-evidence.js";
import { SCRIPT_RUNTIME_VERSION } from "@tabductor/core";
import { tasks, type CompiledScriptRow, type Db } from "@tabductor/db";
import type { Metrics } from "@tabductor/telemetry";
import { eq } from "drizzle-orm";


/** Compile all recorded Python cells from a completed task run. The LLM first
 * distils grounded work, then writes a Python module checked in replay sandboxes.
 * No candidate is stored until changed-input and failure scenarios pass. */

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
  metrics?: Metrics;
  /** Retry budget for a model that returns something a gate rejects. */
  maxAttempts?: number;
  validatePython?: (source:string,evidence:import("./sdk-evidence.js").SdkEvidence,plan:SdkPlan)=>Promise<{ok:true}|{ok:false;reason:string}>;
};

export type CompileInput = {
  taskId: string;
  /** The run that made the task eligible — the primary evidence, and the provenance anchor. */
  sourceRunId: string;
  /** The source run's trace first; anything else available is supporting evidence. */
  traces: RunTrace[];
  /** Learner recommendations are hints; operation evidence and replay remain authoritative. */
  learning?: Record<string, unknown>;
};

export type CompileStage = "kind" | "evidence" | "llm" | "plan" | "lint" | "validation";

export type CompileResult =
  | { ok: true; script: CompiledScriptRow; plan: WorkPlan | SdkPlan }
  | { ok: false; stage: CompileStage; error: string };

/**
 * `kind='browser'` only, and written as an allowlist on purpose.
 *
 * Decision work remains semantic and is deliberately excluded. The allowlist makes adding
 * any future kind an explicit compiler decision.
 */
/** Browser compilation uses only complete, versioned Python evidence. */
export async function compileTask(deps: CompileDeps, input: CompileInput): Promise<CompileResult> {
  const start=Date.now();
  let outcome:"ok"|CompileStage="evidence";
  try {
    const [task]=await deps.db.select().from(tasks).where(eq(tasks.id,input.taskId));
    if (!task || task.kind!=="browser") return {ok:false,stage:"kind",error:"Only browser tasks compile"};
    const trace=input.traces.find(t=>t.runId===input.sourceRunId);
    const runtime=trace?.entries.find(e=>e.kind==="runtime")?.payload;
    if (!runtime || runtime.runtimeVersion!==SCRIPT_RUNTIME_VERSION || typeof runtime.browserVersion!=="string")
      return {ok:false,stage:"evidence",error:"Run the task with the current Python browser runtime before compiling"};
    const result=await compileSdkTask(deps,input,{runtimeVersion:SCRIPT_RUNTIME_VERSION,browserVersion:runtime.browserVersion});
    outcome=result.ok?"ok":result.stage;
    return result;
  } finally {
    deps.metrics?.compileRuns.add({outcome});deps.metrics?.compileDuration.record((Date.now()-start)/1000,{outcome});
  }
}

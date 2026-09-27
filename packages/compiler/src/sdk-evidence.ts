import { z } from "zod";
import type { HelperRevision } from "@tabductor/static-rt";
import type { RunTrace } from "./evidence.js";

export const PLANNED_DEOPT_EVIDENCE_KEY = "plannedDeopt";

const plannedDeoptSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  /** Successful source operations the agent must reproduce after the static prefix stops. */
  operationIds: z.array(z.string().min(1)).min(1),
  /** The task-specific instruction passed to the runtime agent. */
  prompt: z.string().min(20),
  /** Why these operations require runtime semantic judgment instead of deterministic code. */
  why: z.string().min(1),
});

export const sdkPlanSchema = z.object({
  goal: z.string().min(1),
  guards: z.array(z.object({ operationId: z.string(), condition: z.string().min(1) })).min(1),
  steps: z.array(z.object({ operationId: z.string(), why: z.string().min(1) })).min(1),
  bindings: z.array(z.object({ source: z.string().min(1), use: z.string().min(1) })),
  discarded: z.array(z.object({ operationId: z.string(), why: z.string().min(1) })),
  /** At most one terminal AI handoff. The current script runtime cannot resume after AI work. */
  deopts: z.array(plannedDeoptSchema).max(1).optional(),
  recoveryPrompt: z.string().min(1),
});
export type SdkPlan = z.infer<typeof sdkPlanSchema>;
export type RecordedOperation = {
  operationId: string; invocationId: string; sequence: number; name: string; effect: boolean;
  args: Record<string, unknown>; result: Record<string, unknown>; target?: string;
};
export type SdkEvidence = {
  input: unknown; invocations: Record<string, unknown>[]; operations: RecordedOperation[];
  helpers: HelperRevision[]; api: Array<{ name: string; parameters: unknown }>;
  sourceLanguage?: "python" | "javascript";
  callbacks?: Record<string,unknown>[];
};
export const requiredWork = (op: RecordedOperation): boolean => op.result.ok === true &&
  /^(?:(?:workflow\.)?(?:store\.(?:query|insert|upsert|define_table)|emit(?:\.batch)?|record\.(?:outcome|verify)|destination\.(?:contract\.publish|field\.observe)|done)|browser\.ai|(?:page|harness)\.verify)$/.test(op.name);
const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
const omitted = (v: unknown): boolean => !!v && typeof v === "object" &&
  (obj(v).evidenceOmitted === true || Object.values(v).some(omitted));

export function readSdkEvidence(trace: RunTrace): SdkEvidence {
  const invocations = trace.entries.filter(e => e.payload.action === "sdk.invocation").map(e => e.payload);
  if (invocations.some(i => i.operationVersion !== undefined && ![1,2,3].includes(Number(i.operationVersion)))) throw new Error("Unsupported SDK operation version");
  if (!invocations.length || invocations.some(i => i.evidenceOmitted || omitted(i.input) || typeof i.source !== "string")) throw new Error("Incomplete SDK invocation evidence");
  const starts = trace.entries.filter(e => e.payload.action === "sdk.operation" && e.payload.phase === "started");
  const ends = new Map(trace.entries.filter(e => e.payload.action === "sdk.operation" && e.payload.phase === "finished")
    .map(e => [e.payload.operationId, e.payload]));
  const operations = starts.map(({ payload: p }) => {
    const end = ends.get(p.operationId);
    if (!end || omitted(p.args) || omitted(end.result)) throw new Error("Incomplete SDK operation evidence");
    return { operationId: String(p.operationId), invocationId: String(p.invocationId), sequence: Number(p.sequence),
      name: String(p.name), effect: p.effect === true, args: obj(p.args), result: end.error ? { ok: false, error: end.error } : obj(end.result),
      ...(typeof p.target === "string" ? { target: p.target } : {}) };
  });
  if (!operations.some(o => ["done","workflow.done"].includes(o.name) && o.result.ok)) throw new Error("No verified SDK completion in trace");
  const helpers = new Map<string, HelperRevision>();
  const python = invocations.some(i => i.language === "python");
  // Coordinate actions and binary transfers still require target/file provenance.
  // Browser JS and same-origin requests are validated using their recorded inputs,
  // results, guards, and counterfactual runtime values.
  if (operations.some(o => o.result.ok && ["harness.upload","harness.download"].includes(o.name)))
    throw new Error("Binary transfers require complete file evidence before promotion");
  const used = operations.filter(o => ["helpers.use","internal.helpers.use"].includes(o.name));
  for (const invocation of invocations) for (const helper of (invocation.helpers ?? []) as HelperRevision[]) {
    if (!used.some(op => op.invocationId === invocation.invocationId && op.args.name === helper.name && op.args.revision === helper.revision)) continue;
    const previous = helpers.get(helper.name);
    if (!python && previous && previous.revision !== helper.revision) throw new Error("A JavaScript helper changed during the successful work; collect a stable trace");
    helpers.set(helper.name, helper);
  }
  const evidence: SdkEvidence = { input: invocations[0]!.input, invocations:invocations.map(({api: _api,...invocation})=>invocation), operations,
    sourceLanguage: python ? "python" : "javascript",
    callbacks:trace.entries.filter(e=>e.payload.action==="playwright.callback").map(e=>e.payload),
    helpers: invocations.some(i=>i.operationVersion===3) ? (invocations.at(-1)!.helpers ?? []) as HelperRevision[] : python ? [] : [...helpers.values()], api: invocations.at(-1)!.api as SdkEvidence["api"] };
  if (JSON.stringify(evidence).length > 8_000_000) throw new Error("SDK evidence exceeds compile budget; narrow the task or record a shorter successful run");
  return evidence;
}

export function checkSdkPlan(plan: SdkPlan, evidence: SdkEvidence): string | undefined {
  const ids = new Map(evidence.operations.map((o, index) => [o.operationId, { operation: o, index }]));
  const kept = new Set([...plan.guards, ...plan.steps].map(s => s.operationId));
  const discarded = new Set(plan.discarded.map(s => s.operationId));
  const delegated = new Set<string>();
  for (const deopt of plan.deopts ?? []) {
    for (const id of deopt.operationIds) {
      if (delegated.has(id)) return "Operation is delegated by more than one planned deopt";
      delegated.add(id);
    }
  }
  if ([...kept,...discarded,...delegated].some(id => !ids.has(id))) return "Plan references an unobserved operation";
  if ([...kept].some(id => discarded.has(id) || delegated.has(id)) || [...discarded].some(id => delegated.has(id)))
    return "Operation is retained, discarded, and/or delegated more than once";
  if (evidence.operations.some(o => requiredWork(o) && !kept.has(o.operationId) && !delegated.has(o.operationId)))
    return "Plan dropped verified work, an emission, or completion";
  if (plan.guards.some(g => !["playwright.call", "workflow.store.query"].includes(ids.get(g.operationId)!.operation.name) && !/^(?:page\.(?:perceive|find|inspect|waitFor)|harness\.(?:observe|find|extract|wait_for_element|js|request|page_info))/.test(ids.get(g.operationId)!.operation.name))) return "Guards must depend on observed browser or store state";
  if (evidence.operations.some(o => o.name === "workflow.store.query" && kept.has(o.operationId) && !plan.guards.some(g => g.operationId === o.operationId))) return "Store queries must guard current store state";
  if (evidence.operations.some(o => o.result.ok && !kept.has(o.operationId) && !discarded.has(o.operationId) && !delegated.has(o.operationId)))
    return "Every successful operation needs a retained, delegated, or discarded explanation";

  const planned = plan.deopts?.[0];
  if (planned) {
    const delegatedOperations = planned.operationIds.map(id => ids.get(id)!).sort((a,b) => a.index-b.index);
    if (delegatedOperations.some(({operation}) => operation.result.ok !== true))
      return "A planned deopt may delegate only successful observed operations";
    const boundary = delegatedOperations[0]!.index;
    if ([...kept].some(id => ids.get(id)!.index >= boundary))
      return "A planned deopt must be a terminal suffix; retained operations cannot follow its boundary";
    if (!plan.steps.some(step => ids.get(step.operationId)!.index < boundary))
      return "A planned deopt needs a non-empty reusable static prefix";
    if (evidence.operations.slice(boundary).some(o => o.result.ok && !discarded.has(o.operationId) && !delegated.has(o.operationId)))
      return "A planned deopt must delegate every non-discarded successful operation in its suffix";
  }
  return undefined;
}

/** The marker is accepted only when it names a deopt stored in the validated artifact plan. */
export function isPlannedDeopt(plan: unknown, evidence: unknown): boolean {
  if (!plan || typeof plan !== "object" || !evidence || typeof evidence !== "object") return false;
  const marker = (evidence as Record<string, unknown>)[PLANNED_DEOPT_EVIDENCE_KEY];
  const deopts = (plan as Record<string, unknown>).deopts;
  return typeof marker === "string" && Array.isArray(deopts) && deopts.some(item =>
    item && typeof item === "object" && (item as Record<string, unknown>).id === marker);
}

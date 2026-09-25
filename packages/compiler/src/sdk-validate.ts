import { randomUUID } from "node:crypto";
import ts from "typescript";
import { runToolScript } from "@tabductor/static-rt";
import { requiredWork, type RecordedOperation, type SdkEvidence, type SdkPlan } from "./sdk-evidence.js";

const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
const canonical = (v: unknown): string => JSON.stringify(v, (key,value) => {
  if (["content","body"].includes(key) && typeof value === "string" && /^\s*[\[{]/.test(value)) {
    try { return { jsonContent:JSON.parse(value) }; } catch { /* ordinary text */ }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))) : value;
});
const businessEffect = (op: RecordedOperation) => op.effect && !["done","fail","memory.set","page.goto","workspace.commit","workspace.write"].includes(op.name);

/** Pure JS and local helpers are allowed. The isolate, not this lint, is the capability boundary. */
export function lintSdkScript(source: string): string | undefined {
  const file = ts.createSourceFile("browser.js",source,ts.ScriptTarget.ESNext,true,ts.ScriptKind.JS);
  let error: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isWithStatement(node) ||
      ts.isIdentifier(node) && ["eval","Function","require","process","fetch","WebSocket"].includes(node.text)) error = "Imports, dynamic evaluation, and ambient capabilities are unavailable";
    ts.forEachChild(node,visit);
  };
  visit(file);
  return error;
}

/** Replay only retained operations. Change all input values and ephemeral handles to catch
 * baked-in examples; then remove guard observations, both before and after each effect.
 * No live browser, network, or event bus is reachable from this host. */
export async function validateSdkCandidate(source: string, evidence: SdkEvidence, plan: SdkPlan): Promise<{ok:true}|{ok:false;reason:string}> {
  const lint = [source,...evidence.helpers.map(h=>h.source)].map(lintSdkScript).find(Boolean);
  if (lint) return {ok:false,reason:lint};
  const selected = new Set([...plan.guards,...plan.steps].map(s=>s.operationId));
  const plannedDeopt = plan.deopts?.[0];
  const operations = evidence.operations.filter(o=>selected.has(o.operationId));
  const guards = new Set(plan.guards.map(g=>g.operationId));
  const required = operations.filter(requiredWork);
  const replacements = new Map<string,string>();
  const numbers = new Map<number,number>();
  const seed = randomUUID().slice(0,8);
  const collect = (v: unknown, path = "input") => {
    if (typeof v === "string" && v) replacements.set(v, /^https?:\/\//.test(v)
      ? `https://validation-${seed}.invalid/${path.replace(/[^a-zA-Z0-9]/g,'_')}` : `validation-${seed}-${path.replace(/[^a-zA-Z0-9]/g,'_')}`);
    else if (typeof v === "number") numbers.set(v,v+137);
    else if (v && typeof v === "object") for (const [key,value] of Object.entries(v)) collect(value,`${path}.${key}`);
  };
  collect(evidence.input);
  // Extraction output is another runtime input. A compiler cannot copy the observed
  // batch into literals just because it did not originate in the trigger packet.
  for (const op of operations) if (["page.extract","batch.read","harness.find","harness.js","harness.request"].includes(op.name)) {
    const value = op.result.value;
    const records = Array.isArray(value) ? value : obj(value).records ?? obj(value).elements ?? obj(value).data;
    if (Array.isArray(records)) collect(records, "records");
  }
  const handles = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    for (const [key,value] of Object.entries(v)) {
      if (["anchor","scopeAnchor","snapshotId","batchId","destinationContractId"].includes(key) && typeof value === "string") replacements.set(value,`handle-${seed}-${replacements.size}`);
      if (key === "id" && typeof value === "string" && value.startsWith("destination_")) replacements.set(value,`destination_${seed}`);
      handles(value);
    }
  };
  operations.forEach(o=>handles(o.result));
  const replace = (v: unknown): unknown => {
    if (typeof v === "number") return numbers.get(v) ?? v;
    if (typeof v === "string") {
      if (/^\s*[\[{]/.test(v)) {
        try { return JSON.stringify(replace(JSON.parse(v))); } catch { /* ordinary text */ }
      }
      if (replacements.has(v)) return replacements.get(v)!;
      for (const [from,to] of [...replacements].sort(([a],[b])=>b.length-a.length)) if (from.length >= 4) v = (v as string).split(from).join(to);
      return v;
    }
    if (Array.isArray(v)) return v.map(replace);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k,value])=>[k,replace(value)]));
    return v;
  };
  const replay = async (breakAfter?: number, failedOperation?: string, emptyGuard = false, faultValue?: unknown) => {
    const seen = new Set<string>();
    const emissions = new Set<string>();
    let terminal = "", violated = "", effects = 0, guardBroken = false;
    let deoptId: unknown, deoptReason: unknown;
    const match = (op: RecordedOperation, name: string, args: unknown) => op.name === name && canonical(replace(op.args)) === canonical(args);
    const execute = async () => runToolScript(source, async (name,args) => {
      if (terminal) throw new Error("terminal");
      if (name === "run.deopt") {
        terminal = "deopt";
        deoptReason = obj(args).reason;
        deoptId = obj(obj(args).evidence).plannedDeopt;
        return {ok:true,value:args};
      }
      if (name === "helpers.use") {
        const helper = evidence.helpers.find(h=>h.name === obj(args).name && h.revision === obj(args).revision);
        return helper ? {ok:true,value:{name:helper.name,revision:helper.revision}} : {ok:false,error:"Unknown helper revision"};
      }
      const op = operations.find(o=>!seen.has(o.operationId) && match(o,name,args));
      if (!op) { violated = `Ungrounded, repeated or sample-bound operation: ${name}`; return {ok:false,error:violated}; }
      if (op.operationId === failedOperation || breakAfter !== undefined && effects >= breakAfter && guards.has(op.operationId)) {
        guardBroken = true;
        return {ok:emptyGuard,error:"Observed target changed",outcomeUncertain:op.effect,value:faultValue ?? {elements:[],text:"",url:"about:blank"}};
      }
      if (guardBroken && op.effect) { violated = "Effect attempted after a guard failure"; return {ok:false,error:violated}; }
      if (businessEffect(op) && operations.some(previous=>businessEffect(previous) && !seen.has(previous.operationId) && operations.indexOf(previous)<operations.indexOf(op))) {
        violated = "Candidate reordered effects"; return {ok:false,error:violated};
      }
      seen.add(op.operationId);
      if (businessEffect(op)) effects++;
      if (name === "emit" || name === "emit.batch") {
        const items = name === "emit" ? [obj(args)] : (obj(args).items ?? []) as Record<string,unknown>[];
        if (!items.length || items.some(item=>typeof item.dedupeKey !== "string" || !item.dedupeKey)) {
          violated="Every emitted record requires a stable dedupe key"; return {ok:false,error:violated};
        }
        for (const item of items) emissions.add(String(item.dedupeKey));
      }
      if (name === "done" && op.result.ok) terminal = "done";
      if (name === "fail") terminal = "fail";
      return replace(op.result);
    }, { wallClockMs:1000,maxCalls:1000,operationNames:evidence.api.map(t=>t.name),input:replace(evidence.input),helpers:evidence.helpers });
    await execute();
    return {terminal,violated,seen,effects,guardBroken,emissions,deoptId,deoptReason};
  };
  const normal = await replay();
  const retained = operations.filter(o=>o.result.ok && !["helpers.use"].includes(o.name));
  const expectedTerminal = plannedDeopt ? "deopt" : "done";
  const plannedMismatch = plannedDeopt && (normal.deoptId !== plannedDeopt.id || normal.deoptReason !== plannedDeopt.prompt);
  if (normal.violated || normal.terminal !== expectedTerminal || plannedMismatch || [...required,...retained].some(o=>!normal.seen.has(o.operationId)))
    return {ok:false,reason:normal.violated || (plannedMismatch ? "Candidate did not preserve the planned AI handoff" : "Candidate omitted required work or did not finish on changed input")};
  // The runtime fences a failed operation too; validation requires the authored guard to
  // explicitly deopt before any additional effect instead of continuing on stale state.
  const broken = await replay(0);
  if (!broken.guardBroken || broken.terminal !== "deopt" || broken.violated || broken.effects || plannedDeopt && broken.deoptId === plannedDeopt.id)
    return {ok:false,reason:"Candidate does not deopt before effects when its initial guard fails"};
  const empty = await replay(0, undefined, true);
  if (!empty.guardBroken || empty.terminal !== "deopt" || empty.violated || empty.effects || plannedDeopt && empty.deoptId === plannedDeopt.id)
    return {ok:false,reason:"Candidate does not check the contents of its initial observation"};
  // A successful transport is not proof of a usable dataset or API response.
  // Guard malformed records, duplicated identities, and changed collection sizes.
  for (const op of operations.filter(o=>guards.has(o.operationId))) {
    const value = replace(op.result.value);
    const rows = Array.isArray(value) ? value : obj(value).data;
    const variants: unknown[] = [];
    if (Array.isArray(rows) && rows.length && rows.every(r=>r && typeof r==="object" && !Array.isArray(r))) {
      const wrap = (changed: unknown[]) => Array.isArray(value) ? changed : {...obj(value),data:changed};
      variants.push(wrap(rows.slice(0,-1)),wrap([...rows,rows[0]]));
      if (rows.length>1) variants.push(wrap([...rows.slice(0,-1),rows[0]]));
      for (const key of Object.keys(obj(rows[0]))) {
        const incomplete = {...obj(rows[0])}; delete incomplete[key];
        variants.push(wrap([incomplete,...rows.slice(1)]));
      }
    }
    if (op.name === "harness.request") variants.push({...obj(value),ok:false,status:409,data:{error:"schema changed"}});
    for (const variant of variants) {
      const changed = await replay(undefined,op.operationId,true,variant);
      if (!changed.guardBroken || changed.terminal!=="deopt" || changed.violated || plannedDeopt && changed.deoptId === plannedDeopt.id)
        return {ok:false,reason:`Candidate does not guard changed record count, duplicate identity, field schema or API response in ${op.name}`};
    }
  }
  for (const boundary of [...new Set(operations.filter(o=>guards.has(o.operationId)).map(o=>operations.slice(0,operations.indexOf(o)).filter(businessEffect).length))].filter(n=>n>0)) {
    const changed = await replay(boundary);
    if (changed.guardBroken && (changed.terminal !== "deopt" || changed.violated || plannedDeopt && changed.deoptId === plannedDeopt.id)) return {ok:false,reason:"Candidate replays or continues effects after a mid-run guard failure"};
  }
  // An acknowledged prefix stays applied. Fail the next effect with an ambiguous
  // outcome and require handoff, never a retry or another mutation on stale state.
  for (const op of operations.filter(o=>businessEffect(o))) {
    const partial = await replay(undefined, op.operationId);
    if (!partial.guardBroken || partial.terminal !== "deopt" || partial.violated || plannedDeopt && partial.deoptId === plannedDeopt.id)
      return {ok:false,reason:`Candidate does not hand off an uncertain ${op.name} without replaying effects`};
  }
  return {ok:true};
}

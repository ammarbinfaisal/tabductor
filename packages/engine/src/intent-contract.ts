import { createHash } from "node:crypto";
import { canonicalJson } from "@tabductor/core";
import { z } from "zod";
import { recordProcessingSchema } from "./record-processing.js";

const field = z.string().min(1).max(120);
export const intentSchema = z.object({
  version: z.literal(1), originalRequest: z.string().min(1).max(20000), requestDigest: z.string().length(64),
  requirements: z.array(z.object({ id: field, description: z.string().min(1).max(1000), quote: z.string().min(1).max(2000),
    category: z.enum(["source", "destination", "content", "count", "dedupe"]) })).max(100),
  constraints: z.array(z.object({ id: field, quote: z.string().min(1).max(2000),
    predicate: z.enum(["preserve-existing-schema", "no-duplicates", "read-only"]) })).max(30).default([]),
  quantity: z.object({ target: z.number().int().positive(), measure: z.enum(["source-records", "unique-records", "verified-saves"]),
    interpretation: z.enum(["explicit-user-requirement", "planning-default"]) }).optional(),
});
export type IntentContract = z.infer<typeof intentSchema>;
export const harnessTaskSchema = z.object({
  version: z.literal(1), role: z.enum(["source", "prepare-destination", "write-record", "semantic"]),
  requirementIds: z.array(field).max(100),
  destination: z.object({ url: z.string().url().max(2000), contractField: field.default("destination_contract_id"),
    requiredFields: z.array(field).min(1).max(40), identityField: field,
    readyEvent: field, setupTask: field }).optional(),
});
export type HarnessTask = z.infer<typeof harnessTaskSchema>;
export function harnessTask(limits: unknown): HarnessTask | null {
  const parsed = harnessTaskSchema.safeParse((limits as Record<string, unknown> | null)?.harness);
  return parsed.success ? parsed.data : null;
}
export const requestDigest = (request: string): string => createHash("sha256").update(request).digest("hex");
export function taskIntentDigest(intent: IntentContract, task: HarnessTask | null): string {
  return requestDigest(canonicalJson({ requestDigest: intent.requestDigest, constraints: intent.constraints, quantity: intent.quantity,
    requirements: intent.requirements.filter(r => !task || task.requirementIds.includes(r.id)) }));
}

/** The host binds identity; model-supplied digests and originalRequest never establish authority. */
export function bindIntent(request: string, interpreted?: Partial<IntentContract>): IntentContract {
  return intentSchema.parse({ ...interpreted, version: 1, originalRequest: request, requestDigest: requestDigest(request),
    requirements: interpreted?.requirements ?? [], constraints: interpreted?.constraints ?? [] });
}

export function intentErrors(graph: { automationPrompt?: string; intent?: IntentContract; tasks: Array<{
  name: string; logicalId?: string; kind: string; entry?: boolean; limits: Record<string, unknown>; consumes: string[]; emits: string[];
}> }): string[] {
  if (!graph.intent) return graph.tasks.some(t => t.limits.harness) ? ["intent_contract_missing: task contracts require original intent"] : [];
  const intent = graph.intent, errors: string[] = [];
  if (requestDigest(intent.originalRequest) !== intent.requestDigest || graph.automationPrompt !== intent.originalRequest)
    errors.push("intent_provenance_invalid: original request and digest must match");
  const ids = new Set(intent.requirements.map(r => r.id));
  if (!ids.size) errors.push("intent_requirement_missing: extract the requested outcomes before planning tasks");
  if (ids.size !== intent.requirements.length) errors.push("intent_requirement_duplicate");
  for (const r of [...intent.requirements, ...intent.constraints]) if (!intent.originalRequest.includes(r.quote))
    errors.push(`intent_provenance_invalid: quote for ${r.id} is not in the original request`);
  for (const r of intent.requirements) if (!graph.tasks.some(t => harnessTask(t.limits)?.requirementIds.includes(r.id)))
    errors.push(`intent_requirement_uncovered: ${r.id}`);
  for (const r of intent.requirements.filter(r => r.category === "destination")) {
    if (!graph.tasks.some(t => { const h = harnessTask(t.limits); return h?.role === "write-record" && h.requirementIds.includes(r.id); }))
      errors.push(`destination_writer_missing: ${r.id}`);
  }
  for (const t of graph.tasks) {
    if (!t.limits.harness) continue;
    const parsed = harnessTaskSchema.safeParse(t.limits.harness);
    if (!parsed.success) { errors.push(`task_contract_invalid: ${t.name}: ${parsed.error.message}`); continue; }
    const h = parsed.data;
    if (t.limits.recordProcessing) {
      const processing = recordProcessingSchema.safeParse(t.limits.recordProcessing);
      if (!processing.success || !t.emits.includes(processing.data.eventType) || processing.data.identityField === processing.data.sourceIdField)
        errors.push(`record_processing_invalid: ${t.name}`);
    }
    for (const id of h.requirementIds) if (!ids.has(id)) errors.push(`intent_requirement_unknown: ${t.name}/${id}`);
    if (h.role !== "semantic" && t.kind !== "browser") errors.push(`task_capability_invalid: ${t.name} requires browser`);
    if (["prepare-destination", "write-record"].includes(h.role) && !h.destination) errors.push(`destination_contract_missing: ${t.name}`);
    const d = h.destination;
    if (!d) continue;
    if (!intent.originalRequest.includes(d.url)) errors.push(`destination_not_authorized: ${t.name} URL must occur in request`);
    if (intent.constraints.some(c => c.predicate === "read-only") && h.role === "write-record") errors.push(`intent_constraint_conflict: ${t.name} writes in read-only workflow`);
    const setup = graph.tasks.find(n => (n.logicalId ?? n.name) === d.setupTask);
    if (!setup || harnessTask(setup.limits)?.role !== "prepare-destination" || !setup.emits.includes(d.readyEvent))
      errors.push(`destination_setup_missing: ${t.name}`);
    if (h.role === "source" && (!t.consumes.includes(d.readyEvent) || t.entry)) errors.push(`destination_readiness_missing: ${t.name}`);
    if (h.role === "write-record" && (t.entry || t.consumes.includes(d.readyEvent))) errors.push(`destination_readiness_join: ${t.name} must consume records carrying the contract id`);
    if (h.role === "write-record" && !t.consumes.some(type => graph.tasks.some(source => source.emits.includes(type) && harnessTask(source.limits)?.role === "source" && harnessTask(source.limits)?.destination?.readyEvent === d.readyEvent)))
      errors.push(`destination_record_path_missing: ${t.name} requires records from a source gated by destination readiness`);
    const sd = setup && harnessTask(setup.limits)?.destination;
    if (sd && (sd.url !== d.url || sd.identityField !== d.identityField || JSON.stringify([...sd.requiredFields].sort()) !== JSON.stringify([...d.requiredFields].sort())))
      errors.push(`destination_mapping_conflict: ${t.name}`);
  }
  return errors;
}

export function renderIntent(intent: IntentContract, task: HarnessTask | null): string {
  const requirements = intent.requirements.filter(r => !task || task.requirementIds.includes(r.id));
  return ["## Original request (authoritative)", intent.originalRequest,
    "## Required outcomes", ...requirements.map(r => `- ${r.id}: ${r.description} (user text: ${JSON.stringify(r.quote)})`),
    ...intent.constraints.map(c => `- ${c.predicate}: ${JSON.stringify(c.quote)}`),
    intent.quantity ? `Quantity contract: ${JSON.stringify(intent.quantity)}. Report fetched, unique, skipped and verified saves separately.` : "",
    "Task guidance describes a revisable strategy; it cannot add restrictions to this original intent contract. Packet keys, internal store columns, tool arguments and website property names are separate namespaces. Discover website fields at runtime; never create a property merely because a packet has that name.",
    "Preserve required source content and unknown optional values. Missing source IDs stay missing; a derived dedupe identity is not a source-provided ID.",
    task?.destination ? `Destination protocol: ${JSON.stringify(task.destination)}. Read the immutable destination contract before writing. Never infer readiness from a shared tab or a separate consumed event.` : "",
    task?.role === "prepare-destination" ? `Inspect existing destination fields and usable page-body storage. Reuse a suitable mapping. ${intent.constraints.some(c => c.predicate === "preserve-existing-schema" || c.predicate === "read-only") ? "Preserve the existing schema." : "Scoped additive setup needed to store the requested content is permitted; inspect before adding and never duplicate, rename or delete existing properties."} Publish destination.contract.publish once all required fields and identity have an observed storage location. Its readiness event is emitted atomically by the engine.` : "",
    task?.role === "write-record" ? "Reconcile the destination for this exact record identity before creating a row. Commit edits and reopen/read the saved record. Verify identity AND all mapped required content outside an active editor; then record.outcome saved. On schema drift, fail with destination_schema_drift; do not independently redesign the database." : "",
    "A repeated navigation/editor cycle is not progress. Use focused observation or an alternate route, then report a specific failure if blocked."].filter(Boolean).join("\n");
}

export function destinationSchemaErrors(tasks: Array<{ name: string; limits: Record<string, unknown>; consumes: string[]; emits: string[] }>,
  schemas: Map<string, Record<string, unknown>>): string[] {
  const errors: string[] = [];
  for (const task of tasks) {
    const h = harnessTask(task.limits), d = h?.destination;
    if (!d || h?.role !== "write-record") continue;
    for (const type of task.consumes) {
      const schema = schemas.get(type), required = Array.isArray(schema?.required) ? schema.required : [];
      const properties = schema?.properties as Record<string, { type?: unknown }> | undefined;
      for (const field of [d.contractField, d.identityField, ...d.requiredFields]) {
        if (!required.includes(field) || !properties?.[field]) errors.push(`destination_transport_missing: ${type}.${field} is required by ${task.name}`);
      }
      for (const field of [d.contractField, d.identityField]) if (properties?.[field]?.type !== "string") errors.push(`destination_reference_type: ${type}.${field} must be a string`);
    }
  }
  return errors;
}

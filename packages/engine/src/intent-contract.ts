import { createHash } from "node:crypto";
import { canonicalJson } from "@tabductor/core";
import { z } from "zod";

const field = z.string().min(1).max(120);
export const intentSchema = z.object({
  version: z.literal(1), originalRequest: z.string().min(1).max(20000), requestDigest: z.string().length(64),
  requirements: z.array(z.object({ id: field, description: z.string().min(1).max(1000), quote: z.string().min(1).max(2000),
    category: field.optional() })).max(100),
  constraints: z.array(z.object({ id: field, quote: z.string().min(1).max(2000),
    predicate: field })).max(30).default([]),
  quantity: z.object({ target: z.number().int().positive(), measure: z.enum(["source-records", "unique-records", "verified-saves"]),
    interpretation: z.enum(["explicit-user-requirement", "planning-default"]) }).optional(),
});
export type IntentContract = z.infer<typeof intentSchema>;
export const harnessTaskSchema = z.object({
  version: z.literal(1),
  requirementIds: z.array(field).max(100),
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
  for (const t of graph.tasks) {
    if (!t.limits.harness) continue;
    const parsed = harnessTaskSchema.safeParse(t.limits.harness);
    if (!parsed.success) { errors.push(`task_contract_invalid: ${t.name}: ${parsed.error.message}`); continue; }
    for (const id of parsed.data.requirementIds) if (!ids.has(id)) errors.push(`intent_requirement_unknown: ${t.name}/${id}`);
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
    "A repeated navigation/editor cycle is not progress. Use focused observation or an alternate route, then report a specific failure if blocked."].filter(Boolean).join("\n");
}

import { createHash } from "node:crypto";
import { AppError, canonicalJson, newId } from "@tabductor/core";
import { destinationPreparations, destinationContracts, destinationRecords, runs, workflowVersions, type Db, type RunRow, type TaskRow, type EventRow } from "@tabductor/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { assertRunLease } from "./run-lease.js";
import { harnessTask } from "./intent-contract.js";

export const destinationMappingSchema = z.object({
  canonicalUrl: z.string().url().max(2000),
  fields: z.array(z.object({ packetField: z.string().min(1).max(120), label: z.string().min(1).max(200),
    location: z.enum(["property", "page-body", "title"]) })).min(1).max(50),
  identityField: z.string().min(1).max(120), verificationFields: z.array(z.string().min(1).max(120)).min(1).max(50),
  dedupe: z.enum(["search-before-create", "unique-property"]),
});
export type DestinationMapping = z.infer<typeof destinationMappingSchema>;
export type DestinationEvidence = { url: string; snapshotId: string; observedLabels: string[] };
export type StoredDestination = DestinationMapping & { id: string; revision: number; destinationKey: string };

/** Known database IDs ignore view parameters. Unknown sites retain query/fragment identity. */
export function destinationKey(url: string): string {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new AppError("destination_url_invalid", "Destination must be an HTTP(S) website");
  const hostname = u.hostname.toLowerCase();
  if (hostname === "notion.so" || hostname.endsWith(".notion.so") || hostname.endsWith(".notion.site")) {
    const id = u.pathname.replaceAll("-", "").match(/[a-f\d]{32}(?=\/|$)/i)?.[0];
    if (id) return `notion:${id.toLowerCase()}`;
  }
  u.searchParams.sort(); u.pathname = u.pathname.replace(/\/$/, "") || "/";
  return u.toString();
}
async function workflowIdOf(db: Db, task: TaskRow): Promise<string> {
  const [version] = await db.select({ workflowId: workflowVersions.workflowId }).from(workflowVersions).where(eq(workflowVersions.id, task.workflowVersionId));
  if (!version) throw new Error("workflow_version_missing");
  return version.workflowId;
}
const error = (code: string, message: string): never => { throw new AppError(code, message); };

export async function claimDestinationPreparation(db: Db, run: RunRow, task: TaskRow): Promise<"prepare" | "ready" | "busy"> {
  const d = harnessTask(task.limitsJson)?.destination;
  if (!d || !run.executionId) return error("destination_capability_denied", "Setup requires an execution-scoped destination");
  const key = destinationKey(d.url);
  return db.transaction(async trx => {
    await assertRunLease(trx, run.id, run.leaseGeneration);
    await trx.insert(destinationPreparations).values({ executionId: run.executionId!, destinationKey: key,
      ownerRunId: run.id, leaseGeneration: run.leaseGeneration, status: "preparing" }).onConflictDoNothing();
    const scope = and(eq(destinationPreparations.executionId, run.executionId!), eq(destinationPreparations.destinationKey, key));
    const [claim] = await trx.select().from(destinationPreparations).where(scope).for("update");
    if (claim!.status === "ready") return "ready";
    if (claim!.ownerRunId !== run.id) {
      const [owner] = await trx.select({ status: runs.status }).from(runs).where(eq(runs.id, claim!.ownerRunId));
      if (owner && ["queued", "running", "awaiting_approval", "awaiting_human"].includes(owner.status)) return "busy";
    }
    await trx.update(destinationPreparations).set({ ownerRunId: run.id, leaseGeneration: run.leaseGeneration, updatedAt: new Date() }).where(scope);
    return "prepare";
  });
}

export async function destinationCompletionError(db: Db, run: RunRow, task: TaskRow): Promise<string | null> {
  const h = harnessTask(task.limitsJson);
  if (h?.role !== "prepare-destination" || !h.destination) return null;
  if (!run.executionId) return "destination_readiness_missing: setup requires an execution";
  const [ready] = await db.select({ id: destinationContracts.id }).from(destinationContracts)
    .innerJoin(destinationPreparations, and(eq(destinationPreparations.executionId, destinationContracts.executionId), eq(destinationPreparations.destinationKey, destinationContracts.destinationKey)))
    .where(and(eq(destinationContracts.executionId, run.executionId), eq(destinationContracts.destinationKey, destinationKey(h.destination.url)), eq(destinationPreparations.status, "ready")));
  return ready ? null : "destination_readiness_missing: publish the observed mapping before finishing setup";
}

export async function prepareDestinationContract(db: Db, run: RunRow, task: TaskRow, input: DestinationMapping, evidence: DestinationEvidence): Promise<StoredDestination> {
  const h = harnessTask(task.limitsJson), d = h?.destination;
  if (h?.role !== "prepare-destination" || !d || !run.executionId) return error("destination_capability_denied", "Only the declared setup task may publish a mapping");
  const mapping = destinationMappingSchema.parse(input), key = destinationKey(d.url);
  if (destinationKey(mapping.canonicalUrl) !== key || destinationKey(evidence.url) !== key || !evidence.snapshotId)
    return error("destination_evidence_mismatch", "Observe the authorized destination before publishing its mapping");
  const fields = new Set(mapping.fields.map(f => f.packetField));
  const required = [...d.requiredFields, d.identityField];
  if (fields.size !== mapping.fields.length || required.some(f => !fields.has(f) || !mapping.verificationFields.includes(f)) || mapping.identityField !== d.identityField)
    return error("destination_mapping_incomplete", "Map and verify every required content field and the stable identity");
  if (mapping.fields.some(f => !evidence.observedLabels.some(label => label === f.label || label.includes(f.label))))
    return error("destination_field_unobserved", "Mapping labels must be present in the current observation; inspect the destination first");
  // Multiple packet fields may intentionally share a labeled page-body section, not a property.
  const properties = mapping.fields.filter(f => f.location !== "page-body").map(f => f.label);
  if (new Set(properties).size !== properties.length) return error("destination_mapping_ambiguous", "Separate required values need separate properties or page-body storage");
  await assertRunLease(db, run.id, run.leaseGeneration);
  const preparation = await db.update(destinationPreparations).set({ status: "ready", updatedAt: new Date() })
    .where(and(eq(destinationPreparations.executionId, run.executionId), eq(destinationPreparations.destinationKey, key),
      eq(destinationPreparations.ownerRunId, run.id), eq(destinationPreparations.leaseGeneration, run.leaseGeneration))).returning();
  if (!preparation.length) return error("destination_preparation_lost", "This run no longer owns destination preparation");
  const [existing] = await db.select().from(destinationContracts).where(and(eq(destinationContracts.executionId, run.executionId), eq(destinationContracts.destinationKey, key))).orderBy(desc(destinationContracts.revision)).limit(1);
  if (existing) {
    if (canonicalJson(destinationMappingSchema.parse(existing.contractJson)) !== canonicalJson(mapping))
      return error("destination_schema_drift", "An immutable mapping already exists. Reconcile the existing setup; start a new execution for a revised mapping");
    return { ...mapping, id: existing.id, revision: existing.revision, destinationKey: key };
  }
  const id = newId("destination"), revision = 1;
  await db.insert(destinationContracts).values({ id, executionId: run.executionId, destinationKey: key, revision,
    createdByRunId: run.id, contractJson: { ...mapping, evidence, mappingDigest: createHash("sha256").update(canonicalJson(mapping)).digest("hex") } });
  return { ...mapping, id, revision, destinationKey: key };
}

export async function readDestinationContract(db: Db, run: RunRow, task: TaskRow, trigger: EventRow | null, id?: string): Promise<StoredDestination> {
  const h = harnessTask(task.limitsJson), d = h?.destination;
  if (!d || !run.executionId) return error("destination_capability_denied", "This task has no destination contract capability");
  const boundId = (trigger?.packet as Record<string, unknown> | undefined)?.[d.contractField];
  if (typeof boundId !== "string" || id && id !== boundId) return error("destination_reference_missing", "Use the contract reference carried by this trigger packet");
  const [row] = await db.select().from(destinationContracts).where(and(eq(destinationContracts.id, boundId),
    eq(destinationContracts.executionId, run.executionId), eq(destinationContracts.destinationKey, destinationKey(d.url))));
  if (!row) return error("destination_contract_stale", "The destination reference is missing, from another execution, or targets a different database");
  const mapping = destinationMappingSchema.parse(row.contractJson);
  if (d.requiredFields.some(f => !mapping.fields.some(m => m.packetField === f)) || mapping.identityField !== d.identityField)
    return error("destination_mapping_incomplete", "The mapping does not cover this task contract");
  return { ...mapping, id: row.id, revision: row.revision, destinationKey: row.destinationKey };
}

/** A live writer fences another run. Reclaimed pending records always require UI reconciliation. */
export async function claimDestinationRecord(db: Db, run: RunRow, task: TaskRow, trigger: EventRow | null): Promise<"write" | "saved" | "busy"> {
  if (harnessTask(task.limitsJson)?.role !== "write-record") return "write";
  const mapping = await readDestinationContract(db, run, task, trigger);
  const workflowId = await workflowIdOf(db, task);
  const key = String((trigger?.packet as Record<string, unknown>)?.[mapping.identityField] ?? "");
  if (!key || key.length > 2000) return error("record_key_missing", "Writer needs the declared stable identity");
  return db.transaction(async trx => {
    await assertRunLease(trx, run.id, run.leaseGeneration);
    await trx.insert(destinationRecords).values({ workflowId: workflowId, destinationKey: mapping.destinationKey,
      recordKey: key, ownerRunId: run.id, leaseGeneration: run.leaseGeneration, status: "pending" }).onConflictDoNothing();
    const [row] = await trx.select().from(destinationRecords).where(and(eq(destinationRecords.workflowId, workflowId),
      eq(destinationRecords.destinationKey, mapping.destinationKey), eq(destinationRecords.recordKey, key))).for("update");
    if (row!.status === "saved") return "saved";
    if (row!.ownerRunId !== run.id) {
      const [owner] = await trx.select({ status: runs.status }).from(runs).where(eq(runs.id, row!.ownerRunId));
      if (owner && ["queued", "running", "awaiting_approval", "awaiting_human"].includes(owner.status)) return "busy";
    }
    await trx.update(destinationRecords).set({ ownerRunId: run.id, leaseGeneration: run.leaseGeneration, updatedAt: new Date() })
      .where(and(eq(destinationRecords.workflowId, workflowId), eq(destinationRecords.destinationKey, mapping.destinationKey), eq(destinationRecords.recordKey, key)));
    return "write";
  });
}

export async function saveDestinationRecord(db: Db, run: RunRow, task: TaskRow, trigger: EventRow | null, verification: Record<string, unknown>): Promise<void> {
  if (harnessTask(task.limitsJson)?.role !== "write-record") return;
  const mapping = await readDestinationContract(db, run, task, trigger);
  const workflowId = await workflowIdOf(db, task);
  const key = String((trigger?.packet as Record<string, unknown>)?.[mapping.identityField] ?? "");
  if (verification.destinationContractId !== mapping.id || verification.recordKey !== key || verification.committed !== true)
    return error("destination_verification_missing", "Verify committed identity and all mapped content before recording saved");
  const rows = await db.update(destinationRecords).set({ status: "saved", verificationJson: verification, updatedAt: new Date() })
    .where(and(eq(destinationRecords.workflowId, workflowId), eq(destinationRecords.destinationKey, mapping.destinationKey),
      eq(destinationRecords.recordKey, key), eq(destinationRecords.ownerRunId, run.id), eq(destinationRecords.leaseGeneration, run.leaseGeneration),
      sql`${destinationRecords.status} = 'pending'`)).returning();
  if (!rows.length) {
    const [saved] = await db.select().from(destinationRecords).where(and(eq(destinationRecords.workflowId, workflowId),
      eq(destinationRecords.destinationKey, mapping.destinationKey), eq(destinationRecords.recordKey, key),
      eq(destinationRecords.ownerRunId, run.id), eq(destinationRecords.leaseGeneration, run.leaseGeneration), eq(destinationRecords.status, "saved")));
    if (!saved) return error("destination_claim_lost", "The writer no longer owns this destination record");
  }
}

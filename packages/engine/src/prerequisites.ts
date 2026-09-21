import { browserFleetStatus, browserWorkers, browserSessions, browserProfileLeases, workflowBrowserProfiles, cdpEndpoints, modelCredentials, modelSelections, runs, tasks, workflowExecutions, workflowVersions, workflows, type Db } from "@tabductor/db";
import { and, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";

export type PrerequisiteBlock = { code: string; message: string };
export type PrerequisiteOptions = { browserMode: "fleet" | "endpoints";
  platformProviders: readonly string[]; platformModels: readonly { provider: string; model: string }[] };

/** Admission probes make no model requests or allocations and never read credential values.
 * An execution accepted without a selection is pinned once configuration becomes available. */
export async function checkWorkflowPrerequisites(db: Db, taskId: string, opts: PrerequisiteOptions, executionId?: string | null): Promise<PrerequisiteBlock | null> {
  const [origin] = await db.select({ task: tasks, workflow: workflows }).from(tasks)
    .innerJoin(workflowVersions, eq(workflowVersions.id, tasks.workflowVersionId))
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId)).where(eq(tasks.id, taskId));
  if (!origin) return { code: "task_missing", message: "The workflow step no longer exists." };
  const [execution] = executionId ? await db.select().from(workflowExecutions).where(eq(workflowExecutions.id, executionId)) : [];
  const versionId = execution?.workflowVersionId ?? origin.workflow.currentVersionId ?? origin.task.workflowVersionId;
  const steps = await db.select({ mode: tasks.mode, kind: tasks.kind }).from(tasks).where(eq(tasks.workflowVersionId, versionId));
  if (steps.some(step => step.mode === "ai" || step.mode === "compiled")) {
    const selections = await db.select().from(modelSelections).where(eq(modelSelections.accountId, origin.workflow.accountId));
    // A missing selection at original admission can be filled before the first run starts.
    const selected = execution?.modelSelectionJson ?? selections.find(s => s.scope === origin.workflow.id) ?? selections.find(s => s.scope === "account");
    if (!selected) return { code: "model_selection_missing", message: "Choose a model in workflow or account settings to start." };
    if (selected.funding === "byo") {
      const [credential] = await db.select({ id: modelCredentials.id }).from(modelCredentials).where(and(
        eq(modelCredentials.id, selected.credentialId ?? ""), eq(modelCredentials.accountId, origin.workflow.accountId),
        eq(modelCredentials.provider, selected.provider), isNull(modelCredentials.revokedAt)));
      if (!credential) return { code: "model_credential_missing", message: "The selected model credential is missing or revoked. Restore it or start a new execution with another model." };
    } else {
      if (!opts.platformProviders.includes(selected.provider)) return { code: "model_platform_unavailable", message: "The selected model provider is unavailable." };
      if (!opts.platformModels.some(model => model.provider === selected.provider && model.model === selected.model)) return { code: "model_rate_unknown", message: "The selected platform model has no configured rate." };
    }
    if (execution && !execution.modelSelectionJson) await db.update(workflowExecutions).set({ modelSelectionJson: {
      funding: selected.funding, provider: selected.provider, model: selected.model, credentialId: selected.credentialId,
    } }).where(and(eq(workflowExecutions.id, execution.id), isNull(workflowExecutions.modelSelectionJson)));
  }
  if (steps.some(step => step.kind === "browser" && step.mode !== "stub")) {
    const [controller] = opts.browserMode === "fleet" ? await db.select().from(browserFleetStatus)
      .where(and(eq(browserFleetStatus.id, "fleet"), gt(browserFleetStatus.maxAllocated, 0), gt(browserFleetStatus.heartbeatAt, new Date(Date.now() - 90_000)))) : [];
    const available = opts.browserMode === "fleet"
      ? await db.select({ id: browserWorkers.id }).from(browserWorkers).where(and(inArray(browserWorkers.status, ["warm", "allocated"]),
        gt(browserWorkers.heartbeatAt, new Date(Date.now() - 180_000)), isNotNull(browserWorkers.endpointUrl))).limit(1)
      : await db.select({ id: cdpEndpoints.id }).from(cdpEndpoints).where(and(eq(cdpEndpoints.workflowId, origin.workflow.id), eq(cdpEndpoints.healthy, true))).limit(1);
    if (!controller && !available.length) return { code: "browser_unavailable", message: opts.browserMode === "fleet"
      ? "Waiting for an available browser service." : "Connect a healthy browser endpoint in workflow settings." };
    if (opts.browserMode === "fleet") {
      const [lease] = await db.select({ executionId: browserSessions.executionId }).from(workflowBrowserProfiles)
        .innerJoin(browserProfileLeases, eq(browserProfileLeases.profileId, workflowBrowserProfiles.profileId))
        .innerJoin(browserSessions, eq(browserSessions.id, browserProfileLeases.sessionId))
        .where(and(eq(workflowBrowserProfiles.workflowId, origin.workflow.id), inArray(browserSessions.status, ["allocating", "ready", "running", "stopping"])));
      if (lease && lease.executionId !== executionId) return { code: "browser_profile_busy", message: "The workflow browser profile is in use. Waiting for that session to finish." };
    }
  }
  return null;
}

export async function persistPrerequisiteBlock(db: Db, taskId: string, block: PrerequisiteBlock | null, runId?: string, workflowBlock = block): Promise<void> {
  const [owner] = await db.select({ workflowId: workflowVersions.workflowId }).from(tasks)
    .innerJoin(workflowVersions, eq(workflowVersions.id, tasks.workflowVersionId)).where(eq(tasks.id, taskId));
  if (!owner) return;
  await db.update(workflows).set({ blockedReasonJson: workflowBlock }).where(eq(workflows.id, owner.workflowId));
  if (runId) {
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    if (run?.executionId) await db.update(workflowExecutions).set({ blockedReasonJson: block }).where(eq(workflowExecutions.id, run.executionId));
    if (block) await db.update(runs).set({ notBefore: new Date(Date.now() + 30_000) }).where(and(eq(runs.id, runId), eq(runs.status, "queued")));
  }
}

/** Scheduled blocks may have no queued run to recheck. Resolve them independently of
 * the next cron occurrence so repairing settings also enables a manual start. */
export async function refreshWorkflowBlocks(db: Db, opts: PrerequisiteOptions): Promise<void> {
  const blocked = await db.selectDistinctOn([workflows.id], { workflowId: workflows.id, taskId: tasks.id })
    .from(workflows).leftJoin(tasks, eq(tasks.workflowVersionId, workflows.currentVersionId))
    .where(isNotNull(workflows.blockedReasonJson)).orderBy(workflows.id, tasks.id);
  for (const row of blocked) {
    const block = row.taskId ? await checkWorkflowPrerequisites(db, row.taskId, opts) : null;
    await db.update(workflows).set({ blockedReasonJson: block }).where(eq(workflows.id, row.workflowId));
  }
}

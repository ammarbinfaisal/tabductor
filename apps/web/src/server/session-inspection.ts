import { DEFAULT_TOKEN_PATTERNS, maskText } from "@tabductor/core";
import {
  browserCommands, browserSessionActivity, browserSessions, browserTabLeases, events, runs,
  tasks, workflowExecutions, workflows, type BrowserSessionActivityRow, type Db, type TraceEntryRow,
} from "@tabductor/db";
import { listActivityGroups, readWorkflowDefinition } from "@tabductor/engine";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

export const INSPECTION_LIMIT = 1000;
const position = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - INSPECTION_LIMIT);
export const inspectionOptionsSchema = z.object({
  limit: z.number().int().min(1).max(INSPECTION_LIMIT).default(INSPECTION_LIMIT),
  cursor: z.object({ runs: position, packets: position, traces: position, activity: position }).optional(),
});
const LABELS = ["navigation", "screenshot", "interaction", "extract", "wait", "agent_update", "workflow_event", "tool"] as const;
type Label = typeof LABELS[number];
type Session = Pick<typeof browserSessions.$inferSelect, "id" | "status">;
type SessionEvidence = Session & { runId: string | null };
export type RunSession = Session & { sessionHref: string; sessionCount: number; evidence: "commands" | "lease" };

/** Durable commands win over transient leases. Multiple historical sessions have no single answer. */
export function resolveRunSessions(commands: SessionEvidence[], leases: SessionEvidence[]): Map<string, RunSession> {
  const result = new Map<string, RunSession>();
  const grouped = new Map<string, Map<string, SessionEvidence>>();
  for (const row of [...commands, ...leases]) {
    if (!row.runId) continue;
    if (!grouped.has(row.runId)) grouped.set(row.runId, new Map());
  }
  const commandRuns = new Set(commands.map(row => row.runId));
  for (const row of [...commands, ...leases.filter(row => !commandRuns.has(row.runId))]) {
    if (row.runId) grouped.get(row.runId)!.set(row.id, row);
  }
  for (const [runId, sessions] of grouped) {
    if (!sessions.size) continue;
    const row = [...sessions.values()].at(-1)!;
    result.set(runId, { id: row.id, status: row.status, sessionHref: `/sessions/${encodeURIComponent(row.id)}`,
      sessionCount: sessions.size, evidence: commandRuns.has(runId) ? "commands" : "lease" });
  }
  return result;
}

/** Two account-scoped batched queries, regardless of the number of runs in a page. */
export async function sessionsForRuns(db: Db, accountId: string, runIds: string[]): Promise<Map<string, RunSession>> {
  if (!runIds.length) return new Map();
  const [commands, leases] = await Promise.all([
    db.select({ runId: browserCommands.runId, id: browserSessions.id, status: browserSessions.status }).from(browserCommands)
      .innerJoin(browserSessions, eq(browserSessions.id, browserCommands.sessionId))
      .where(and(inArray(browserCommands.runId, runIds), eq(browserSessions.accountId, accountId)))
      .groupBy(browserCommands.runId, browserSessions.id, browserSessions.status).orderBy(asc(browserSessions.createdAt)),
    db.select({ runId: browserTabLeases.runId, id: browserSessions.id, status: browserSessions.status }).from(browserTabLeases)
      .innerJoin(browserSessions, eq(browserSessions.id, browserTabLeases.sessionId))
      .where(and(inArray(browserTabLeases.runId, runIds), eq(browserSessions.accountId, accountId),
        inArray(browserSessions.status, ["ready", "running"]))),
  ]);
  return resolveRunSessions(commands, leases);
}

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const identifier = (value: unknown): string | null => typeof value === "string" && /^[\w.:-]{1,200}$/.test(value) ? value : null;
const numeric = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const sensitiveKey = /password|passwd|secret|token|authorization|cookie|credential|api.?key|private.?key|reasoning|thought|chain.?of.?thought|scratchpad|prompt|completion|^args$|^source$|^code$|^headers$|^stack$/i;

function safeText(value: string, max = 2000): string {
  return maskText(value.slice(0, max), DEFAULT_TOKEN_PATTERNS)
    .replace(/(?:https?:\/\/|www\.)[^\s<>"']+/gi, "[URL REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL REDACTED]")
    .replace(/\b(?:password|passwd|secret|token|credential)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "[REDACTED]");
}

/** Owner-visible business packets, not raw trace/model payloads. Bound both depth and total work. */
export function sanitizeInspectionData(value: unknown): unknown {
  let remaining = 1000;
  function visit(current: unknown, depth: number): unknown {
    if (--remaining < 0 || depth > 8) return "[TRUNCATED]";
    if (typeof current === "string") return safeText(current);
    if (current === null || typeof current === "boolean" || typeof current === "number") return current;
    if (Array.isArray(current)) return current.slice(0, 100).map(item => visit(item, depth + 1));
    const record = object(current);
    if (record.private === true || record.evidenceOmitted === true) return "[PRIVATE]";
    return Object.fromEntries(Object.entries(record).slice(0, 100).map(([key, item]) =>
      [safeText(key, 100), sensitiveKey.test(key) ? "[REDACTED]" : visit(item, depth + 1)]));
  }
  return visit(value, 0);
}

const TOOL_LABELS: Record<string, Label> = {
  "page.goto": "navigation", "goto": "navigation", "page.screenshot": "screenshot", "browser.screenshot": "screenshot",
  "page.click": "interaction", "click": "interaction", "page.type": "interaction", "type": "interaction",
  "page.scroll": "interaction", "scroll": "interaction", "secrets.fill": "interaction", "page.extract": "extract",
  "page.perceive": "extract", "queryAll": "extract", "page.waitFor": "wait", "waitFor": "wait",
  "page.waitForLoadState": "wait", "waitForLoadState": "wait", "network.waitForResponse": "wait",
  emit: "workflow_event", done: "agent_update", fail: "agent_update", "agent.done": "agent_update", "agent.fail": "agent_update",
};
const LEGACY_ACTIONS = ["goto", "click", "type", "scroll", "waitFor", "waitForLoadState", "queryAll", "emit",
  "network.list", "network.read", "network.body", "network.waitForResponse", "agent.done", "agent.fail", "secrets.fill"];
const TITLES: Record<Label, string> = {
  navigation: "Navigation", screenshot: "Screenshot", interaction: "Interact with page",
  extract: "Inspect page", wait: "Wait for browser", agent_update: "Agent update", workflow_event: "Publish workflow event", tool: "Run tool",
};
type ActionRun = { id: string; taskId: string; taskName: string; triggerEventId: string | null };
type Summary = { summary: string | null; status: string; label?: string | null };
export type InspectionItem = {
  id: string; runId: string | null; taskId: string | null; runtimeName: string | null; triggerEventId: string | null;
  emittedEventIds: string[]; kind: string; label: string; description: string;
  status: "running" | "succeeded" | "failed" | "info"; occurredAt: Date; offsetMs: number | null;
  callId: string | null; details: Record<string, unknown>; summaryStatus: string;
};

/** Payload task/run/trigger ids are not authority. Raw source, arguments and thoughts never leave this projection. */
export function inspectionAction(entry: TraceEntryRow, run: ActionRun, summary?: Summary): InspectionItem | null {
  if (entry.kind === "llm") return null;
  const payload = object(entry.payloadJson);
  if (payload.private === true || payload.evidenceOmitted === true) return null;
  const isTool = entry.kind === "action" && payload.action === "tool.call";
  const isLegacy = entry.kind === "action" && LEGACY_ACTIONS.includes(String(payload.action));
  const isEmit = entry.kind === "action" && payload.action === "emit";
  if (!isTool && !isLegacy && entry.kind !== "navigation") return null;
  const tool = isTool ? identifier(payload.tool) : isLegacy ? identifier(payload.action) : null;
  if (tool === "browser.events") return null;
  const fallback: Label = entry.kind === "navigation" ? "navigation"
    : isEmit ? "workflow_event" : (tool && TOOL_LABELS[tool]) || "tool";
  const label = summary?.status === "ready" && LABELS.includes(summary.label as Label) ? summary.label as Label : fallback;
  let description = fallback === "navigation" || fallback === "screenshot" ? TITLES[fallback] : summary?.status === "ready" && summary.summary?.trim()
    ? safeText(summary.summary, 240).replace(/\s+/g, " ").trim() : TITLES[fallback];
  const eventId = (isEmit || tool === "emit") && payload.ok === true && payload.deduped !== true ? identifier(payload.eventId) : null;
  const details: Record<string, unknown> = {};
  // Do not echo arbitrary operation names, which may contain private identifiers.
  if (tool && (TOOL_LABELS[tool] || ["browser.python", "browser.code"].includes(tool))) details.tool = tool;
  const durationMs = numeric(payload.duration_ms);
  if (durationMs !== null) details.durationMs = durationMs;
  if (isEmit && typeof payload.deduped === "boolean") details.deduped = payload.deduped;
  return {
    id: `${run.id}:${entry.seq}`, runId: run.id, taskId: run.taskId, runtimeName: run.taskName,
    callId: identifier(payload.callId), kind: entry.kind, occurredAt: entry.createdAt,
    description, label, summaryStatus: summary?.status ?? "unavailable", triggerEventId: run.triggerEventId,
    status: payload.ok === false || payload.phase === "rejected_or_failed" ? "failed" : payload.ok === true ? "succeeded"
      : payload.phase === "started" ? "running" : "info",
    emittedEventIds: eventId ? [eventId] : [], details,
    // Execution evidence is not recording evidence. Neither a shared execution nor a run's
    // command binding aligns individual traces with this session's recording clock.
    offsetMs: null,
  };
}

const ACTIVITY_TITLES: Record<string, string> = {
  automation_resume_requested: "Request browser automation", automation_resumed: "Resume browser automation",
  session_stop_requested: "Request browser stop", takeover_requested: "Request browser control",
  takeover_started: "Take browser control", takeover_expired: "Browser control expired",
  "page.goto": "Navigation", navigation: "Navigation", "page.click": "Interact with page",
  "page.scroll": "Scroll page", "page.screenshot": "Screenshot", "page.perceive": "Inspect page",
  "page.create": "Open browser tab", "page.close": "Close browser tab", "tab.acquire": "Acquire browser tab",
  "page.wait_for": "Wait for browser", "page.wait_for_load_state": "Wait for browser",
};

export function inspectionActivity(row: BrowserSessionActivityRow, run?: ActionRun | null): InspectionItem | null {
  const payload = object(row.payloadJson);
  if (row.private || payload.private === true || payload.evidenceOmitted === true || row.kind === "browser.events") return null;
  const knownKind = Object.hasOwn(ACTIVITY_TITLES, row.kind);
  const outcome = ["succeeded", "rejected", "uncertain"].includes(String(payload.outcome)) ? String(payload.outcome) : null;
  return {
    id: `activity:${row.cursor}`, runId: run?.id ?? null, taskId: run?.taskId ?? null, runtimeName: run?.taskName ?? null,
    triggerEventId: run?.triggerEventId ?? null, emittedEventIds: [], callId: identifier(payload.callId),
    kind: "session_activity", label: row.kind === "page.goto" || row.kind === "navigation" ? "navigation" : row.kind === "page.screenshot" ? "screenshot" : "tool",
    description: knownKind ? ACTIVITY_TITLES[row.kind]! : "Browser session activity",
    status: outcome === "succeeded" ? "succeeded" : outcome === "rejected" ? "failed" : "info",
    occurredAt: row.createdAt, offsetMs: payload.clock === "recorder" ? numeric(row.offsetMs) : null, summaryStatus: "unavailable",
    details: { ...(knownKind ? { activityKind: row.kind } : {}), ...(outcome ? { outcome } : {}), offsetAccuracy: payload.clock === "recorder" ? "recorder" : "unavailable" },
  };
}

export async function inspectSession(db: Db, accountId: string, sessionId: string, options: z.input<typeof inspectionOptionsSchema> = {}) {
  const { limit, cursor = { runs: 0, packets: 0, traces: 0, activity: 0 } } = inspectionOptionsSchema.parse(options);
  const [session] = await db.select().from(browserSessions)
    .where(and(eq(browserSessions.id, sessionId), eq(browserSessions.accountId, accountId))).limit(1);
  if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Browser session not found" });
  const [execution] = session.executionId ? await db.select({ workflowId: workflowExecutions.workflowId,
    workflowVersionId: workflowExecutions.workflowVersionId, workflowName: workflows.name, status: workflowExecutions.status, summary: workflowExecutions.resultSummary, result: workflowExecutions.resultJson, resultReady: workflowExecutions.resultReady, finalizationStatus: workflowExecutions.finalizationStatus }).from(workflowExecutions)
    .innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
    .where(and(eq(workflowExecutions.id, session.executionId), eq(workflows.accountId, accountId))).limit(1) : [];
  if (session.executionId && !execution) throw new TRPCError({ code: "NOT_FOUND", message: "Execution not found" });
  const runSelection = { id: runs.id, taskId: runs.taskId, taskName: tasks.name, status: runs.status, attempt: runs.attempt,
    triggerEventId: runs.triggerEventId, startedAt: runs.startedAt, endedAt: runs.endedAt, createdAt: runs.createdAt,
    error: runs.error, modeUsed: runs.modeUsed };
  const [definition, relatedSessions, runRows, packetRows] = execution && session.executionId ? await Promise.all([
    readWorkflowDefinition(db, execution.workflowVersionId),
    db.select({ id: browserSessions.id, status: browserSessions.status }).from(browserSessions).where(and(eq(browserSessions.executionId, session.executionId), eq(browserSessions.accountId, accountId))).orderBy(asc(browserSessions.createdAt)),
    db.select(runSelection).from(runs).innerJoin(tasks, eq(tasks.id, runs.taskId))
      .where(eq(runs.executionId, session.executionId)).orderBy(asc(runs.createdAt), asc(runs.id)).limit(limit + 1).offset(cursor.runs),
    db.select({ eventId: events.eventId, type: events.type, sourceTaskId: events.sourceTaskId, sourceRunId: events.sourceRunId,
      causationId: events.causationId, packet: events.packet, occurredAt: events.occurredAt }).from(events)
      .where(eq(events.executionId, session.executionId)).orderBy(asc(events.occurredAt), asc(events.eventId)).limit(limit + 1).offset(cursor.packets),
    Promise.resolve([]),
  ]) : [null, [], [], [], []] as const;
  const activityRows = await db.select({ activity: browserSessionActivity,
    run: { id: runs.id, taskId: runs.taskId, taskName: tasks.name, triggerEventId: runs.triggerEventId } }).from(browserSessionActivity)
    .leftJoin(browserCommands, and(eq(browserCommands.sessionId, browserSessionActivity.sessionId),
      eq(browserCommands.id, sql`${browserSessionActivity.payloadJson}->>'commandId'`)))
    .leftJoin(runs, and(eq(runs.id, browserCommands.runId), session.executionId ? eq(runs.executionId, session.executionId) : sql`false`))
    .leftJoin(tasks, eq(tasks.id, runs.taskId))
    .where(and(eq(browserSessionActivity.sessionId, sessionId), eq(browserSessionActivity.private, false),
      sql`(${browserSessionActivity.payloadJson}->>'private') is distinct from 'true'
        and (${browserSessionActivity.payloadJson}->>'evidenceOmitted') is distinct from 'true'
        and ${browserSessionActivity.kind} <> 'browser.events'`))
    .orderBy(asc(browserSessionActivity.cursor)).limit(limit + 1).offset(cursor.activity);
  const grouped = await listActivityGroups(db,{sessionId,accountId,limit,offset:cursor.traces});
  const items: InspectionItem[] = grouped.items.map(group=>({id:group.id,runId:group.run_id,taskId:null,runtimeName:null,triggerEventId:null,emittedEventIds:[],kind:"activity_group",label:group.label,description:group.description,status:group.status,occurredAt:group.started_at,offsetMs:group.offset_ms===null?null:Number(group.offset_ms),callId:null,details:{revision:group.revision,...(group.blob_ref?{screenshotRef:group.blob_ref}:{})},summaryStatus:"ready"}));
  for (const row of activityRows.slice(0, limit)) {
    if (row.run?.id || object(row.activity.payloadJson).callId) continue;
    const run = row.run;
        const item = inspectionActivity(row.activity, run?.id && run.taskId && run.taskName !== null
          ? { id: run.id, taskId: run.taskId, taskName: run.taskName, triggerEventId: run.triggerEventId } : null);
    if (item && (!item.callId || !items.some(trace => trace.callId === item.callId && trace.runId === item.runId))) items.push(item);
  }
  const rootCalls = new Set(items.filter(item => item.kind === "action" && item.callId).map(item => `${item.runId}:${item.callId}`));
  const deduplicated = items.filter(item => item.kind !== "navigation" || !item.callId || !rootCalls.has(`${item.runId}:${item.callId}`));
  deduplicated.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id));
  const lengths = { runs: runRows.length, packets: packetRows.length, traces: grouped.items.length + (grouped.hasMore ? 1 : 0), activity: activityRows.length };
  const truncated = Object.values(lengths).some(length => length > limit);
  const nextCursor = truncated ? {
    runs: cursor.runs + Math.min(runRows.length, limit), packets: cursor.packets + Math.min(packetRows.length, limit),
    traces: cursor.traces + grouped.items.length, activity: cursor.activity + Math.min(activityRows.length, limit),
  } : null;
  return {
    workflow: execution && definition ? { id: execution.workflowId, name: execution.workflowName, versionId: execution.workflowVersionId, prompt: definition.prompt } : null,
    execution, sessions: [...relatedSessions], runs: runRows.slice(0, limit).map(row => ({ ...row, error: row.error === null ? null : "Run failed (details withheld)" })),
    packets: packetRows.slice(0, limit).map(row => ({ ...row, packet: sanitizeInspectionData(row.packet) })),
    items: deduplicated, truncated, nextCursor, limit, snapshotAt: new Date(),
    // Poll every loaded page again: summaries can change without a new trace row. Cursors
    // are live per-stream offsets, not frozen snapshots; merge refreshed pages by stable id.
    history: { order: "oldest_first" as const, scope: "execution_and_session" as const,
      timebase: "recorder" as const, offsets: "explicit_only" as const },
  };
}

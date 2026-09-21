import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { AppError } from "@tabductor/core";
import type { AnchoredElement, Perception, RunSession, TraceRecorder } from "@tabductor/browser";
import type { CheckpointStore } from "./batch-tools.js";
import type { AgentTool, ToolResult } from "./tools.js";

export const browserMutation = /^(page\.(goto|click|type|scroll|press|select|hover|drag|upload|download|dialog)|tabs\.switch|secrets\.fill)$/;
export const actionSummarySchema = z.object({
  id: z.string().max(80), tool: z.string().max(80),
  target: z.object({ role: z.string().max(80), name: z.string().max(120).optional() }).optional(),
  controls: z.array(z.object({ role: z.string().max(80), name: z.string().max(120).optional() })).max(4).optional(),
  operation: z.string().max(80).optional(),
  dispatch: z.enum(["executed", "rejected", "failed", "uncertain"]),
  changes: z.array(z.string().max(80)).max(8),
  verification: z.enum(["not_checked", "passed", "failed"]),
});
export type BrowserActionSummary = z.infer<typeof actionSummarySchema>;
export const observationMetadataSchema = z.object({
  stability: z.enum(["settled", "unsettled", "unavailable"]), durationMs: z.number().nonnegative(),
  activeScope: z.enum(["dialog", "menu", "listbox", "editor", "page"]),
});
export type ObservationMetadata = z.infer<typeof observationMetadataSchema>;
export const recoverySchema = z.object({
  reason: z.enum(["cycle", "observation_unavailable", "observation_unsettled"]),
  repetitions: z.number().optional(), rejectedAttempts: z.number().optional(),
  cycle: z.array(actionSummarySchema).max(6).optional(),
  suggestedTools: z.array(z.string()).max(6),
});
export type BrowserRecovery = z.infer<typeof recoverySchema>;

export function readActionHistory(value: unknown): BrowserActionSummary[] {
  if (!Array.isArray(value)) return [];
  return boundActionHistory(value.flatMap(item => {
    const parsed = actionSummarySchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  }));
}

export function boundActionHistory(actions: BrowserActionSummary[]): BrowserActionSummary[] {
  const bounded = actions.slice(-20);
  while (JSON.stringify(bounded).length > 12_000) bounded.shift();
  return bounded;
}

/** Descriptions are historical labels, never locators or entered field values. */
export function actionTarget(e: AnchoredElement | undefined): BrowserActionSummary["target"] {
  if (!e) return undefined;
  const editable = e.role === "textbox" || e.tag === "input" || e.tag === "textarea" || e.tag === "select";
  // For editable controls only retain an explicitly supplied static label. The fallback
  // accessible name may be the rich-text body the user just typed.
  const namedControl = ["button", "link", "menuitem", "tab", "checkbox", "radio", "option", "combobox"].includes(e.role ?? "");
  const name = e.inputType === "password" ? undefined : editable || !namedControl ? e.controlLabel : e.name;
  return { role: (e.role ?? e.tag).slice(0, 80), ...(name ? { name: name.slice(0, 120) } : {}) };
}

type Observation = Partial<Perception>;
function observation(value: unknown): Observation | undefined {
  if (!value || typeof value !== "object") return undefined;
  if ("perception" in value) return observation(value.perception);
  return "elements" in value ? value as Observation : undefined;
}
const overlays = new Set(["dialog", "menu", "listbox"]);
export function activeScope(p: Observation): ObservationMetadata["activeScope"] {
  return p.activeScope ?? (p.elements?.find(e => overlays.has(e.role ?? ""))?.role as "dialog" | "menu" | "listbox" | undefined)
    ?? (p.activeEditor ? "editor" : "page");
}

/** Includes values only in an ephemeral hash, never in persisted summaries or traces. */
export function settlingFingerprint(p: Perception): string {
  return p.uiFingerprint ?? createHash("sha256").update(JSON.stringify({
    url: p.url, scope: activeScope(p),
    elements: p.elements.filter(e => e.inViewport !== false && e.role !== "presentation").map(e => ({
      role: e.role, name: e.name, value: e.value, focused: e.focused, disabled: e.disabled,
      checked: e.checked, selected: e.selected, expanded: e.expanded,
    })),
  })).digest("hex");
}

export function observedChanges(before: Observation | undefined, after: Observation | undefined): string[] {
  if (!before || !after) return ["change_unknown"];
  const changes: string[] = [];
  if (before.url !== after.url) changes.push("navigation_observed");
  if (before.activeScope !== undefined && after.activeScope !== undefined && before.activeScope !== after.activeScope) {
    if (overlays.has(before.activeScope)) changes.push(`${before.activeScope}_closed`);
    if (overlays.has(after.activeScope)) changes.push(`${after.activeScope}_opened`);
  }
  const focus = (p: Observation) => p.focusIdentity;
  if (focus(before) !== undefined && focus(after) !== undefined && focus(before) !== focus(after)) changes.push("focus_changed");
  const oldFields = new Map((before.elements ?? []).filter(e => e.actionLocator).map(e => [e.actionLocator, e]));
  if (after.elements?.some(e => {
    const previous = e.actionLocator ? oldFields.get(e.actionLocator) : undefined;
    return previous && e.inputType !== "password" && ["value", "checked", "selected", "expanded", "disabled"].some(key =>
      previous[key as keyof AnchoredElement] !== e[key as keyof AnchoredElement]);
  })) changes.push("field_state_changed");
  if (before.uiFingerprint && after.uiFingerprint && before.uiFingerprint !== after.uiFingerprint) changes.push("ui_changed");
  if (!changes.length) changes.push(before.uiFingerprint && after.uiFingerprint ? "no_visible_change" : "change_unknown");
  return changes;
}

export const terminalBrowserError = (error: unknown): boolean => error instanceof AppError && [
  "human_action_pending", "browser.disconnected", "resource_limit_exceeded", "endpoint_queue_full",
  "no_endpoint_configured", "browser_input_revoked", "browser_fresh_perception_required", "run_lease_lost", "agent_no_progress",
].includes(error.code);

/** Called only AFTER dispatch succeeds. Readback failure cannot undo that fact. */
export async function observeAfterAction(session: RunSession, opts: {
  summarize: (p: Perception) => Record<string, unknown>; signal?: AbortSignal;
  beforeCall?: () => Promise<unknown>;
}): Promise<ToolResult> {
  const started = Date.now();
  const budget = Math.min(1500, session.remainingWallMs?.() ?? 1500);
  let last: Perception | undefined, fingerprint: string | undefined, unchangedSince = started;
  try {
    for (;;) {
      opts.signal?.throwIfAborted();
      const fresh = await opts.beforeCall?.();
      if (fresh !== undefined) throw new AppError("browser_fresh_perception_required", "Browser control changed during observation; plan again.", { details: { perception: fresh, actionExecuted: true } });
      last = await session.page.perceive({ elementLimit: 100 });
      opts.signal?.throwIfAborted();
      const next = settlingFingerprint(last);
      if (next !== fingerprint) { fingerprint = next; unchangedSince = Date.now(); }
      const settled = Date.now() - unchangedSince >= 300;
      if (settled || Date.now() - started >= budget) {
        const stability = settled ? "settled" : "unsettled";
        return { ok: true, value: opts.summarize(last), observation: { stability, durationMs: Date.now() - started, activeScope: activeScope(last) },
          ...(!settled ? { recovery: { reason: "observation_unsettled" as const, suggestedTools: ["page.perceive", "page.waitFor"] } } : {}) };
      }
      await delay(Math.min(150, Math.max(0, budget - (Date.now() - started))), undefined, { signal: opts.signal });
    }
  } catch (error) {
    if (opts.signal?.aborted || terminalBrowserError(error)) throw error;
    return { ok: true, value: null, observation: { stability: "unavailable", durationMs: Date.now() - started, activeScope: last ? activeScope(last) : "page" },
      recovery: { reason: "observation_unavailable", suggestedTools: ["page.perceive"] } };
  }
}

function dispatchOf(result: ToolResult): BrowserActionSummary["dispatch"] {
  if (result.ok) return "executed";
  if (result.outcomeUncertain) return "uncertain";
  if (["invalid_arguments", "interaction_cycle", "interaction_no_progress", "browser_stale_target", "browser_command_rejected", "browser_invalid_argument"].includes(result.code ?? "") || /^(stale anchor|invalid arguments)/.test(result.error)) return "rejected";
  return result.outcomeUncertain === false ? "failed" : "uncertain";
}

export function withActionSummaries(tool: AgentTool, deps: {
  session: RunSession; actions: CheckpointStore; trace?: TraceRecorder;
}): AgentTool {
  if (!browserMutation.test(tool.name) && tool.name !== "page.verify") return tool;
  return { ...tool, async execute(args, signal) {
    const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
    const target = actionTarget(deps.session.anchorInfo?.(String(input.anchor ?? "")));
    const before = deps.session.lastPerception?.();
    const dispatchBefore = deps.session.dispatchState?.().sequence;
    // Only keyboard commands/directions, never typed text, select values, filenames or URLs.
    const operation = tool.name === "page.press" && typeof input.key === "string" && /^(?:(?:Control|Meta|Alt|Shift)\+)*(?:Escape|Enter|Tab|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|[A-Z])$/.test(input.key)
      ? input.key : tool.name === "page.scroll" && ["up", "down", "left", "right"].includes(String(input.direction)) ? String(input.direction) : undefined;
    let result: ToolResult;
    let controlChange: AppError | undefined;
    try { result = await tool.execute(args, signal); }
    catch (error) {
      // The control callback already consumed the fresh observation. Carry it through
      // the exception so the loop doesn't ask that callback twice and lose the evidence.
      if (!(error instanceof AppError) || error.code !== "browser_fresh_perception_required" || !error.details?.actionExecuted) throw error;
      controlChange = error;
      result = { ok: true, value: error.details.perception };
    }
    const after = deps.session.lastPerception?.() ?? observation(result.value);
    const receipt = deps.session.dispatchState?.();
    const dispatch = receipt && receipt.sequence !== dispatchBefore && dispatchOf(result) !== "rejected" ? receipt.status
      : receipt && receipt.sequence === dispatchBefore && !result.ok && !result.outcomeUncertain ? "rejected" : dispatchOf(result);
    const controls = (after?.elements ?? []).filter(e => e.focused || e.role === "textbox" || overlays.has(e.role ?? ""))
      .slice(0, 4).flatMap(e => { const target = actionTarget(e); return target ? [target] : []; });
    const summary: BrowserActionSummary = { id: randomUUID(), tool: tool.name, ...(target ? { target } : {}), ...(operation ? { operation } : {}),
      dispatch, changes: observedChanges(before, after),
      ...(controls.length ? { controls } : {}),
      verification: tool.name === "page.verify" && observation(result.value) ? (result.ok ? "passed" : "failed") : "not_checked" };
    // A failed assertion is a completed observation, not a rejected browser action.
    if (tool.name === "page.verify" && result.value !== undefined) summary.dispatch = "executed";
    if (result.observation?.stability === "unavailable") summary.changes = ["change_unknown"];
    if (controlChange) summary.changes = ["change_unknown", "browser_control_changed"];
    await deps.actions.set(boundActionHistory([...readActionHistory(await deps.actions.get()), summary]));
    await deps.trace?.record("action", { action: "browser.action_summary", summaryId: summary.id, tool: summary.tool,
      dispatch: summary.dispatch, changes: summary.changes, verification: summary.verification,
      ...(result.observation ? { stability: result.observation.stability, settlingMs: result.observation.durationMs } : {}) });
    if (controlChange) throw new AppError(controlChange.code, controlChange.message, { details: { ...controlChange.details, actionSummary: summary } });
    return { ...result, action: summary };
  } };
}

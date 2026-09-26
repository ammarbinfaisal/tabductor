"use client";

import { promptInputsSchema, workflowPromptInputNames } from "@tabductor/core/prompt-inputs";

import type {
  CompileEntry,
  Graph,
  GraphCompileReport,
  GraphDraftArtifact,
  GraphEvent,
  GraphTask,
  NodeKind,
  PersistedGraphCompileReport,
  ProposedGrant,
  TaskSummary,
} from "@tabductor/engine";
import { parseResultSchemaText, resultSchemaTextOf } from "../lib/result-schema.js";
import { createStore } from "zustand/vanilla";
import { api, asApiError, type ApiError } from "../lib/api.js";
import { randomUUID } from "../lib/uuid.js";

/**
 * The declarative editor's client state (U1). One vanilla store: the document being
 * edited — tasks and event entities, no edges, no JSON anywhere — the task ids of the
 * published version (which is what "trigger now" needs), the read-only compiled schemas,
 * and whatever the API last said about a publish.
 *
 * The store never validates a graph. `workflow.publishVersion` is the validator *and the
 * compiler* — the editor's job is to show where its verdict landed, which is why `error`
 * carries `AppError.details` through unchanged and `compileReport` keeps the per-event
 * result of the last publish attempt, failed or not.
 */

export type Selection = { kind: "node" | "event"; id: string } | null;

/**
 * Ephemeral panel state — open menus, pending confirms, one-shot notes. Lives here rather
 * than in `useState` because the hook policy allows exactly one hook (`useMountHook`);
 * everything a component would keep locally goes in the store instead.
 */
export type EditorUi = {
  /** The "Add event" affordance is showing its name input. */
  addingEvent: boolean;
  /** A destructive control mid two-step confirm. */
  confirmingDelete: { kind: "node" | "event"; id: string } | null;
  /** An open chip-adder menu on a node card. */
  chipMenu: { task: string; list: "emits" | "consumes" } | null;
  chipMenuText: string;
  /** Event type to scroll-flash once (banner deep link); consumed by the card's ref. */
  flash: string | null;
};

export type WorkflowScheduleDraft = {
  cron: string;
  timezone: string;
  enabled: boolean;
};

export type EditorState = {
  workspaceTab: "automation" | "activity" | "graph";
  automationPrompt: string;
  promptInputs: Record<string, string>;
  resultSchemaText: string;
  workflowId: string;
  versionId: string | null;
  graph: Graph;
  /** Task rows of the published version, by name — absent for a node not yet saved. */
  taskIds: Record<string, string>;
  /** The published rows themselves: the engine-assigned mode (`compiled` after promotion)
   * and the internal prompt publish compiled. Display-only; the document never carries them. */
  publishedTasks: Record<string, TaskSummary>;
  /** Compiled packet schemas of the published version, by type. Display-only. */
  eventSchemas: Record<string, Record<string, unknown>>;
  selected: Selection;
  dirty: boolean;
  busy: boolean;
  publishing: boolean;
  error: ApiError | null;
  notice: string | null;
  /** The last publish's per-event compile result — `failed` entries mark event cards. */
  compileReport: CompileEntry[] | null;
  authoringReport: GraphCompileReport | null;
  authoringStore: GraphDraftArtifact["store"];
  proposedGrants: ProposedGrant[];
  publishedProposals: Array<ProposedGrant & { id: string }>;
  /**
   * `executorKey` strings the engine registered at boot (U3a), or `null` while unknown.
   * Used to explain when real execution is unavailable; `null` means unknown.
   */
  engineExecutors: string[] | null;
  /** Event types readable through a share link as of the last load or publish (S2d). */
  publishedPublic: string[];
  /**
   * A pending publish whose visibility manifest differs from what is live. Publishing is
   * the moment a packet becomes readable by anyone with a link, so the change is shown
   * before it happens rather than reported after.
   */
  confirmVisibility: { adding: string[]; removing: string[] } | null;
  /** The workflow-level schedule form. Internal entry behavior schedules collapse here. */
  scheduleDraft: WorkflowScheduleDraft;
  ui: EditorUi;
};

const EMPTY_UI: EditorUi = {
  addingEvent: false,
  confirmingDelete: null,
  chipMenu: null,
  chipMenuText: "",
  flash: null,
};

export type EditorStore = ReturnType<typeof createEditorStore>;

const emptyTask = (name: string, kind: NodeKind): GraphTask => ({
  name,
  logicalId: name,
  entry: false,
  kind,
  mode: "ai",
  prompt: null,
  limits: {},
  emits: [],
  consumes: [],
  schedule: null,
  position: null,
});

export function createEditorStore(init: {
  workflowId: string;
  versionId: string | null;
  graph: Graph;
  tasks: TaskSummary[];
  eventSchemas: Record<string, Record<string, unknown>>;
  authoring?: {
    report: PersistedGraphCompileReport | null;
    proposedGrants: Array<ProposedGrant & { id: string }>;
  } | null;
}) {
  let triggerRequestId: string | undefined;
  const triggerStorageKey = `tabductor.trigger.${init.workflowId}`;
  try { triggerRequestId = sessionStorage.getItem(triggerStorageKey) ?? undefined; } catch { /* Server render or storage disabled. */ }
  let pendingInputs: Record<string, string> | undefined;
  try {
    const parsed = promptInputsSchema.safeParse(JSON.parse(sessionStorage.getItem(triggerStorageKey + ".inputs") ?? "null"));
    if (parsed.success) pendingInputs = parsed.data;
  } catch { /* Storage is optional. */ }
  const draft = executionDraft(init.graph);
  const store = createStore<EditorState>(() => ({
    workspaceTab: "automation",
    promptInputs: {},
    automationPrompt: init.graph.automationPrompt ?? "",
    resultSchemaText: resultSchemaTextOf(init.graph),
    workflowId: init.workflowId,
    versionId: init.versionId,
    graph: draft.graph,
    taskIds: Object.fromEntries(init.tasks.map((t) => [t.name, t.id])),
    publishedTasks: Object.fromEntries(init.tasks.map((t) => [t.name, t])),
    eventSchemas: init.eventSchemas,
    selected: null,
    dirty: draft.changed,
    busy: false,
    publishing: false,
    error: null,
    notice: draft.changed ? EXECUTION_NOTICE : null,
    compileReport: null,
    authoringReport: init.authoring?.report?.authoring ?? null,
    authoringStore: null,
    proposedGrants: [],
    publishedProposals: [],
    engineExecutors: null,
    publishedPublic: publicTypesOf(init.graph),
    confirmVisibility: null,
    scheduleDraft: workflowScheduleOf(init.graph).draft,
    ui: EMPTY_UI,
  }));

  // U3a: one fire-and-forget read at store creation. Errors leave `null` — "unknown" renders
  // as nothing disabled, never as a blocking failure of the editor itself.
  void api.engine.status
    .query()
    .then((status) => store.setState({ engineExecutors: status.executors }))
    .catch(() => undefined);

  const edit = (fn: (graph: Graph) => Graph): void =>
    store.setState({
      graph: fn(store.getState().graph),
      dirty: true,
      notice: null,
      authoringReport: null,
      authoringStore: null,
      proposedGrants: [],
    });

  const mapTask = (name: string, fn: (task: GraphTask) => GraphTask): void =>
    edit((graph) => ({ ...graph, tasks: graph.tasks.map((t) => (t.name === name ? fn(t) : t)) }));

  const mapEvent = (type: string, fn: (event: GraphEvent) => GraphEvent): void =>
    edit((graph) => ({ ...graph, events: graph.events.map((e) => (e.type === type ? fn(e) : e)) }));

  return {
    ...store,

    select: (selected: Selection) => store.setState({ selected }),
    setWorkspaceTab: (workspaceTab: EditorState["workspaceTab"]) => store.setState({ workspaceTab, selected: null }),
    setAutomationPrompt: (automationPrompt: string) => store.setState({ automationPrompt }),
    setResultSchemaText: (resultSchemaText: string) => store.setState({ resultSchemaText }),

    setUi: (patch: Partial<EditorUi>) =>
      store.setState({ ui: { ...store.getState().ui, ...patch } }),

    restorePromptInputs: () => {
      if (pendingInputs) store.setState({ promptInputs: pendingInputs });
    },

    setPromptInput: (name: string, value: string) => {
      store.setState({ promptInputs: { ...store.getState().promptInputs, [name]: value } });
    },

    setScheduleDraft: (patch: Partial<WorkflowScheduleDraft>) =>
      store.setState({ scheduleDraft: { ...store.getState().scheduleDraft, ...patch } }),

    /** Restore only after mount so server markup and hydration use the same graph. */
    restoreDraft() {
      if (typeof localStorage === "undefined") return;
      const key = `tabductor:draft:v1:${init.workflowId}`;
      try {
        const saved = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<EditorState> | null;
        if (saved) {
          const compatible = saved.versionId === store.getState().versionId;
          store.setState({
            ...(compatible && typeof saved.automationPrompt === "string" ? { automationPrompt: saved.automationPrompt } : {}),
            ...(compatible && saved.dirty && saved.graph && Array.isArray(saved.graph.tasks) && Array.isArray(saved.graph.events)
              ? { graph: saved.graph, dirty: true, authoringReport: { checks: [], attempts: 1 }, authoringStore: saved.authoringStore ?? null, proposedGrants: [], scheduleDraft: workflowScheduleOf(saved.graph).draft, notice: "Your unpublished draft has been restored." }
              : {}),
          });
        }
      } catch { /* Storage may be unavailable or contain an older format. */ }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const persist = (): void => {
        const { versionId, graph, dirty, authoringStore, proposedGrants, automationPrompt } = store.getState();
        try { localStorage.setItem(key, JSON.stringify({ versionId, graph, dirty, authoringStore, proposedGrants, automationPrompt })); } catch { /* A full/private browser does not block editing. */ }
      };
      const unsubscribe = store.subscribe(() => { clearTimeout(timer); timer = setTimeout(persist, 250); });
      return () => { clearTimeout(timer); persist(); unsubscribe(); };
    },

    /** Banner deep link: select the event and arm the one-shot scroll-flash. */
    goToEvent(type: string) {
      store.setState({
        selected: { kind: "event", id: type },
        ui: { ...store.getState().ui, flash: type },
      });
    },

    /** The card's ref calls this once it has scrolled — the flash is one-shot. */
    consumeFlash() {
      const { ui } = store.getState();
      if (ui.flash !== null) store.setState({ ui: { ...ui, flash: null } });
    },

    addNode(kind: NodeKind) {
      const { graph } = store.getState();
      let name: string = kind;
      for (let n = 2; graph.tasks.some((t) => t.name === name); n += 1) name = `${kind}-${n}`;
      edit((g) => ({ ...g, tasks: [...g.tasks, { ...emptyTask(name, kind), entry: kind !== "result" && g.tasks.length === 0 }] }));
      store.setState({ selected: { kind: "node", id: name } });
    },

    removeNode(name: string) {
      edit((g) => ({ ...g, tasks: g.tasks.filter((t) => t.name !== name) }));
      const { selected } = store.getState();
      if (selected?.kind === "node" && selected.id === name) store.setState({ selected: null });
    },

    /**
     * `tasks.name` is the node's identity across versions, so a rename is genuinely a new
     * node as far as event routing is concerned — worth knowing, not worth blocking. The
     * declarations travel with the task row, so nothing else in the document changes.
     */
    renameNode(from: string, to: string) {
      const trimmed = to.trim();
      if (!trimmed || store.getState().graph.tasks.some((t) => t.name === trimmed)) return;
      edit((g) => ({
        ...g,
        tasks: g.tasks.map((t) => (t.name === from ? { ...t, name: trimmed } : t)),
      }));
      store.setState({ selected: { kind: "node", id: trimmed } });
    },

    patchNode: (name: string, patch: Partial<GraphTask>) => mapTask(name, (t) => ({ ...t, ...patch })),

    /**
     * Declare a new event entity. Born with an empty description on purpose — the editor
     * opens the card for writing, and publish is what insists a description exists.
     */
    addEvent(type: string) {
      const trimmed = type.trim();
      const { graph } = store.getState();
      if (!trimmed || graph.events.some((e) => e.type === trimmed)) return;
      edit((g) => ({ ...g, events: [...g.events, { type: trimmed, description: "", public: false }] }));
      store.setState({ selected: { kind: "event", id: trimmed } });
    },

    /** Removing an entity untangles it everywhere: every emit and consume of it goes too. */
    removeEvent(type: string) {
      edit((g) => ({
        events: g.events.filter((e) => e.type !== type),
        tasks: g.tasks.map((t) => ({
          ...t,
          emits: t.emits.filter((x) => x !== type),
          consumes: t.consumes.filter((x) => x !== type),
        })),
      }));
      const { selected } = store.getState();
      if (selected?.kind === "event" && selected.id === type) store.setState({ selected: null });
    },

    renameEvent(from: string, to: string) {
      const trimmed = to.trim();
      if (!trimmed || store.getState().graph.events.some((e) => e.type === trimmed)) return;
      edit((g) => ({
        events: g.events.map((e) => (e.type === from ? { ...e, type: trimmed } : e)),
        tasks: g.tasks.map((t) => ({
          ...t,
          emits: t.emits.map((x) => (x === from ? trimmed : x)),
          consumes: t.consumes.map((x) => (x === from ? trimmed : x)),
        })),
      }));
      store.setState({ selected: { kind: "event", id: trimmed } });
    },

    patchEvent: (type: string, patch: Partial<GraphEvent>) => mapEvent(type, (e) => ({ ...e, ...patch })),

    /** Wiring is toggling a declaration — the whole replacement for drawing an edge. */
    toggleEmit(task: string, type: string) {
      mapTask(task, (t) => ({
        ...t,
        emits: t.emits.includes(type) ? t.emits.filter((x) => x !== type) : [...t.emits, type],
      }));
    },

    toggleConsume(task: string, type: string) {
      mapTask(task, (t) => ({
        ...t,
        consumes: t.consumes.includes(type) ? t.consumes.filter((x) => x !== type) : [...t.consumes, type],
      }));
    },

    /**
     * Compile prompt/schema edits and publish in one action. A manifest differing from the live
     * one does not publish; it parks the diff for confirmation, and a second call
     * (`confirmed`) goes through. Success refreshes the read-only schemas; failure keeps
     * the per-event report so every failed event card can say why.
     */
    async save(confirmed = false) {
      const state = store.getState();
      if (state.busy) return;
      const intent = state.automationPrompt.trim();
      const needsCompile = state.graph.tasks.length === 0
        || intent !== (state.graph.automationPrompt ?? "")
        || state.resultSchemaText !== resultSchemaTextOf(state.graph);
      store.setState({ busy: true, publishing: true, error: null, notice: "Publishing your automation…", confirmVisibility: null });
      try {
        if (needsCompile) {
          if (!intent) throw new Error("Enter a workflow prompt before publishing.");
          const resultSchema = parseResultSchemaText(state.resultSchemaText);
          const result = await api.workflow.compileIntent.mutate({
            workflowId: state.workflowId, intent, resultSchema,
          });
          if (!result.ok) throw new Error(result.error);
          const graph = { ...result.artifact.graph, automationPrompt: intent };
          store.setState({
            graph, automationPrompt: intent, resultSchemaText: resultSchemaTextOf(graph),
            authoringStore: result.artifact.store, authoringReport: result.report,
            proposedGrants: [], dirty: true, selected: null,
            scheduleDraft: workflowScheduleOf(graph).draft,
          });
        }
        const { workflowId, versionId: baseVersionId, graph, publishedPublic, authoringReport, authoringStore } = store.getState();
        const next = publicTypesOf(graph);
        const adding = next.filter((t) => !publishedPublic.includes(t));
        const removing = publishedPublic.filter((t) => !next.includes(t));
        if ((!confirmed || needsCompile) && (adding.length > 0 || removing.length > 0)) {
          store.setState({ confirmVisibility: { adding, removing }, notice: null });
          return;
        }
        const { versionId, taskIds, report } = await api.workflow.publishVersion.mutate({
          workflowId,
          expectedVersionId: baseVersionId,
          graph,
          ...(authoringReport
            ? {
                authoring: {
                  report: authoringReport,
                  proposedGrants: [],
                  ...(authoringStore ? { store: authoringStore } : {}),
                },
              }
            : {}),
        });
        const got = await api.workflow.get.query({ id: workflowId });
        store.setState({
          versionId,
          taskIds,
          publishedTasks: Object.fromEntries(got.tasks.map((t) => [t.name, t])),
          eventSchemas: got.eventSchemas,
          dirty: false,
          publishedPublic: next,
          scheduleDraft: workflowScheduleOf(got.graph).draft,
          compileReport: report.events,
          authoringReport: got.authoring?.report?.authoring ?? authoringReport,
          proposedGrants: [],
          publishedProposals: [],
          notice: "Workflow published. Future runs will use these changes.",
        });
      } catch (err) {
        const error = asApiError(err);
        store.setState({ error, notice: null, compileReport: reportOf(error) });
      } finally {
        store.setState({ busy: false, publishing: false });
      }
    },

    cancelVisibilityChange: () => store.setState({ confirmVisibility: null }),

    /** Start every externally triggerable entry behavior without exposing internal nodes. */
    async triggerWorkflow() {
      const state = store.getState();
      if (!state.versionId || state.dirty || state.busy || state.automationPrompt.trim() !== (state.graph.automationPrompt ?? "") || state.resultSchemaText !== resultSchemaTextOf(state.graph)) return;
      const names = workflowPromptInputNames(state.graph);
      const inputs = Object.fromEntries(names.map(name => [name, state.promptInputs[name] ?? ""]));
      const missing = names.filter(name => !inputs[name]!.trim());
      if (missing.length) {
        store.setState({ error: { message: `Enter a value for ${missing.map(name => "$" + name).join(", ")}.`, details: {} } });
        return;
      }
      store.setState({ busy: true, error: null, notice: null });
      try {
        if (JSON.stringify(pendingInputs ?? {}) !== JSON.stringify(inputs)) triggerRequestId = undefined;
        pendingInputs = inputs;
        triggerRequestId ??= randomUUID();
        try { sessionStorage.setItem(triggerStorageKey, triggerRequestId); sessionStorage.setItem(triggerStorageKey + ".inputs", JSON.stringify(inputs)); } catch { /* Keep the in-memory key. */ }
        const result = await api.workflow.trigger.mutate({ workflowId: state.workflowId, requestId: triggerRequestId, ...(names.length ? { inputs } : {}) });
        triggerRequestId = undefined;
        try { sessionStorage.removeItem(triggerStorageKey); sessionStorage.removeItem(triggerStorageKey + ".inputs"); } catch { /* Storage is optional. */ }
        store.setState({
          busy: false,
          notice: `Queued ${result.accepted} run${result.accepted === 1 ? "" : "s"} from the published workflow.`,
        });
        return result;
      } catch (err) {
        store.setState({ busy: false, error: asApiError(err) });
      }
    },

    /** A schedule edit is a publication: the resulting version becomes current atomically. */
    async publishSchedule(remove = false) {
      const state = store.getState();
      if (!state.versionId || state.dirty || state.busy || state.automationPrompt.trim() !== (state.graph.automationPrompt ?? "") || state.resultSchemaText !== resultSchemaTextOf(state.graph)) return;
      const cron = state.scheduleDraft.cron.trim();
      const timezone = state.scheduleDraft.timezone.trim();
      if (!remove && (!cron || !timezone)) return;

      store.setState({ busy: true, error: null, notice: null });
      try {
        const result = await api.workflow.setSchedule.mutate({
          workflowId: state.workflowId,
          schedule: remove ? null : { cron, timezone, enabled: state.scheduleDraft.enabled },
        });
        const got = await api.workflow.get.query({ id: state.workflowId });
        const draft = executionDraft(got.graph);
        store.setState({
          versionId: got.versionId,
          graph: draft.graph,
          taskIds: Object.fromEntries(got.tasks.map((task) => [task.name, task.id])),
          publishedTasks: Object.fromEntries(got.tasks.map((task) => [task.name, task])),
          eventSchemas: got.eventSchemas,
          dirty: draft.changed,
          busy: false,
          compileReport: null,
          authoringReport: got.authoring?.report?.authoring ?? null,
          authoringStore: null,
          proposedGrants: [],
          publishedProposals: [],
          publishedPublic: publicTypesOf(got.graph),
          confirmVisibility: null,
          scheduleDraft: workflowScheduleOf(got.graph).draft,
          notice: remove
            ? "Schedule removed."
            : "Schedule published.",
        });
      } catch (err) {
        store.setState({ busy: false, error: asApiError(err) });
      }
    },

    async reload() {
      const got = await api.workflow.get.query({ id: store.getState().workflowId });
      const draft = executionDraft(got.graph);
      store.setState({
        versionId: got.versionId,
        graph: draft.graph,
        automationPrompt: draft.graph.automationPrompt ?? "",
        resultSchemaText: resultSchemaTextOf(draft.graph),
        taskIds: Object.fromEntries(got.tasks.map((t) => [t.name, t.id])),
        publishedTasks: Object.fromEntries(got.tasks.map((t) => [t.name, t])),
        eventSchemas: got.eventSchemas,
        dirty: draft.changed,
        error: null,
        notice: draft.changed ? EXECUTION_NOTICE : "reloaded",
        compileReport: null,
        authoringReport: got.authoring?.report?.authoring ?? null,
        authoringStore: null,
        proposedGrants: [],
        publishedProposals: [],
        publishedPublic: publicTypesOf(got.graph),
        confirmVisibility: null,
        scheduleDraft: workflowScheduleOf(got.graph).draft,
      });
    },
  };
}

export type WorkflowScheduleView = {
  draft: WorkflowScheduleDraft;
  scheduledEntries: number;
  distinctSchedules: number;
};

/** Collapse internal entry schedules into the one workflow-level control the author sees. */
export function workflowScheduleOf(graph: Graph): WorkflowScheduleView {
  const internallyEmitted = new Set(graph.tasks.flatMap((task) => task.emits));
  const entries = graph.tasks.filter(
    (task) => task.kind !== "result" && (graph.contractVersion === 2 ? task.entry : task.consumes.length === 0 || task.consumes.every((type) => !internallyEmitted.has(type))),
  );
  const schedules = entries.flatMap((task) => task.schedule ? [task.schedule] : []);
  const first = schedules[0];
  const distinctSchedules = new Set(
    schedules.map((schedule) => `${schedule.cron}\u0000${schedule.tz}\u0000${schedule.enabled}`),
  ).size;
  return {
    draft: {
      cron: first?.cron ?? "",
      timezone: first?.tz ?? "UTC",
      enabled: first?.enabled ?? true,
    },
    scheduledEntries: schedules.length,
    distinctSchedules,
  };
}

const EXECUTION_NOTICE = "Publish to replace legacy test behavior with real execution.";

/** Legacy test nodes become real nodes in the draft only. Marking the change dirty keeps
 * Run now disabled until the author publishes; opening a workflow changes no live rows. */
function executionDraft(graph: Graph): { graph: Graph; changed: boolean } {
  const changed = graph.tasks.some((task) => task.mode === "stub");
  return {
    changed,
    graph: changed
      ? { ...graph, tasks: graph.tasks.map((task) => task.mode === "stub" ? { ...task, mode: "ai" } : task) }
      : graph,
  };
}

/** The visibility manifest as a flat set of event types — what a share link exposes. */
function publicTypesOf(graph: Graph): string[] {
  return graph.events
    .filter((e) => e.public)
    .map((e) => e.type)
    .sort();
}

/** The compile report a failed publish carries in `AppError.details`, if this was one. */
function reportOf(error: ApiError): CompileEntry[] | null {
  const report = error.details.report;
  if (typeof report !== "object" || report === null) return null;
  const events = (report as { events?: unknown }).events;
  return Array.isArray(events) ? (events as CompileEntry[]) : null;
}

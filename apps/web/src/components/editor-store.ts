"use client";

import type { CompileEntry, Graph, GraphEvent, GraphTask, NodeKind, TaskSummary } from "@tabductor/engine";
import { createStore } from "zustand/vanilla";
import { api, asApiError, type ApiError } from "../lib/api.js";
import { NODE_KINDS } from "../lib/node-kinds.js";

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
  /** Node name → transient "Run queued" note, cleared after 5s. */
  triggeredNote: string | null;
  /** Event type to scroll-flash once (banner deep link); consumed by the card's ref. */
  flash: string | null;
};

export type EditorState = {
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
  error: ApiError | null;
  notice: string | null;
  /** The last publish's per-event compile result — `failed` entries mark event cards. */
  compileReport: CompileEntry[] | null;
  /**
   * `executorKey` strings the engine registered at boot (U3a), or `null` while unknown.
   * The Mode selector disables what is not in here; `null` disables nothing — an engine
   * that has not reported yet should not grey the world out.
   */
  engineExecutors: string[] | null;
  /** Tool-level abilities the engine reported (`python.run`), or `null` while unknown. */
  engineCapabilities: string[] | null;
  /** Event types readable through a share link as of the last load or publish (S2d). */
  publishedPublic: string[];
  /**
   * A pending publish whose visibility manifest differs from what is live. Publishing is
   * the moment a packet becomes readable by anyone with a link, so the change is shown
   * before it happens rather than reported after.
   */
  confirmVisibility: { adding: string[]; removing: string[] } | null;
  ui: EditorUi;
};

const EMPTY_UI: EditorUi = {
  addingEvent: false,
  confirmingDelete: null,
  chipMenu: null,
  chipMenuText: "",
  triggeredNote: null,
  flash: null,
};

export type EditorStore = ReturnType<typeof createEditorStore>;

const emptyTask = (name: string, kind: NodeKind): GraphTask => ({
  name,
  kind,
  mode: NODE_KINDS[kind].defaultMode,
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
}) {
  const store = createStore<EditorState>(() => ({
    workflowId: init.workflowId,
    versionId: init.versionId,
    graph: init.graph,
    taskIds: Object.fromEntries(init.tasks.map((t) => [t.name, t.id])),
    publishedTasks: Object.fromEntries(init.tasks.map((t) => [t.name, t])),
    eventSchemas: init.eventSchemas,
    selected: init.graph.tasks[0] ? { kind: "node", id: init.graph.tasks[0].name } : null,
    dirty: false,
    busy: false,
    error: null,
    notice: null,
    compileReport: null,
    engineExecutors: null,
    engineCapabilities: null,
    publishedPublic: publicTypesOf(init.graph),
    confirmVisibility: null,
    ui: EMPTY_UI,
  }));

  // U3a: one fire-and-forget read at store creation. Errors leave `null` — "unknown" renders
  // as nothing disabled, never as a blocking failure of the editor itself.
  void api.engine.status
    .query()
    .then((status) => store.setState({ engineExecutors: status.executors, engineCapabilities: status.capabilities }))
    .catch(() => undefined);

  const edit = (fn: (graph: Graph) => Graph): void =>
    store.setState({ graph: fn(store.getState().graph), dirty: true, notice: null });

  const mapTask = (name: string, fn: (task: GraphTask) => GraphTask): void =>
    edit((graph) => ({ ...graph, tasks: graph.tasks.map((t) => (t.name === name ? fn(t) : t)) }));

  const mapEvent = (type: string, fn: (event: GraphEvent) => GraphEvent): void =>
    edit((graph) => ({ ...graph, events: graph.events.map((e) => (e.type === type ? fn(e) : e)) }));

  return {
    ...store,

    select: (selected: Selection) => store.setState({ selected }),

    setUi: (patch: Partial<EditorUi>) =>
      store.setState({ ui: { ...store.getState().ui, ...patch } }),

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
      edit((g) => ({ ...g, tasks: [...g.tasks, emptyTask(name, kind)] }));
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

    /** `stub` or `ai` — the only two an author picks (`node-kinds.tsx`). */
    setMode: (name: string, mode: string) => mapTask(name, (t) => ({ ...t, mode })),

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
     * Publish — which is also compile. A first call whose manifest differs from the live
     * one does not publish; it parks the diff for confirmation, and a second call
     * (`confirmed`) goes through. Success refreshes the read-only schemas; failure keeps
     * the per-event report so every failed event card can say why.
     */
    async save(confirmed = false) {
      if (store.getState().busy) return;
      const { workflowId, graph, publishedPublic } = store.getState();

      const next = publicTypesOf(graph);
      const adding = next.filter((t) => !publishedPublic.includes(t));
      const removing = publishedPublic.filter((t) => !next.includes(t));
      if (!confirmed && (adding.length > 0 || removing.length > 0)) {
        store.setState({ confirmVisibility: { adding, removing }, error: null, notice: null });
        return;
      }

      store.setState({ busy: true, error: null, notice: null, confirmVisibility: null });
      try {
        const { versionId, taskIds, report } = await api.workflow.publishVersion.mutate({ workflowId, graph });
        const got = await api.workflow.get.query({ id: workflowId });
        store.setState({
          versionId,
          taskIds,
          publishedTasks: Object.fromEntries(got.tasks.map((t) => [t.name, t])),
          eventSchemas: got.eventSchemas,
          dirty: false,
          busy: false,
          publishedPublic: next,
          compileReport: report.events,
          notice: publishNotice(versionId, report.events),
        });
      } catch (err) {
        const error = asApiError(err);
        store.setState({ busy: false, error, compileReport: reportOf(error) });
      }
    },

    cancelVisibilityChange: () => store.setState({ confirmVisibility: null }),

    /**
     * "Trigger now": publish a synthetic event at the node and let the engine pick the run
     * up. Only offered for a saved node — an unsaved one has no row to trigger.
     */
    async triggerNow(name: string, type?: string) {
      const taskId = store.getState().taskIds[name];
      if (!taskId) return;
      store.setState({ busy: true, error: null, notice: null });
      try {
        const result = await api.run.triggerManual.mutate({ taskId, type: type?.trim() || undefined });
        store.setState({
          busy: false,
          ui: { ...store.getState().ui, triggeredNote: result.runId ? name : null },
        });
        setTimeout(() => {
          const { ui } = store.getState();
          if (ui.triggeredNote === name) store.setState({ ui: { ...ui, triggeredNote: null } });
        }, 5000);
      } catch (err) {
        store.setState({ busy: false, error: asApiError(err) });
      }
    },

    async reload() {
      const got = await api.workflow.get.query({ id: store.getState().workflowId });
      store.setState({
        versionId: got.versionId,
        graph: got.graph,
        taskIds: Object.fromEntries(got.tasks.map((t) => [t.name, t.id])),
        publishedTasks: Object.fromEntries(got.tasks.map((t) => [t.name, t])),
        eventSchemas: got.eventSchemas,
        dirty: false,
        error: null,
        notice: "reloaded",
        compileReport: null,
        publishedPublic: publicTypesOf(got.graph),
        confirmVisibility: null,
      });
    },
  };
}

/** The visibility manifest as a flat set of event types — what a share link exposes. */
function publicTypesOf(graph: Graph): string[] {
  return graph.events
    .filter((e) => e.public)
    .map((e) => e.type)
    .sort();
}

function publishNotice(versionId: string, entries: CompileEntry[]): string {
  const generated = entries.filter((e) => e.status === "generated").length;
  return generated > 0
    ? `published ${versionId} — compiled ${generated} schema${generated === 1 ? "" : "s"}`
    : `published ${versionId}`;
}

/** The compile report a failed publish carries in `AppError.details`, if this was one. */
function reportOf(error: ApiError): CompileEntry[] | null {
  const report = error.details.report;
  if (typeof report !== "object" || report === null) return null;
  const events = (report as { events?: unknown }).events;
  return Array.isArray(events) ? (events as CompileEntry[]) : null;
}

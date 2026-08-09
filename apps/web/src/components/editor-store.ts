"use client";

import type { Graph, GraphTask, NodeKind, TaskSummary } from "@tabductor/engine";
import { createStore } from "zustand/vanilla";
import { api, asApiError, type ApiError } from "../lib/api.js";

/**
 * The graph editor's client state (U0). One vanilla store: the document being edited, the
 * task ids of the published version (which is what "trigger now" needs), and whatever the
 * API last said about a save.
 *
 * The store never validates a graph. `workflow.publishVersion` is the validator — the
 * editor's job is to show where its verdict landed, which is why `error` carries the
 * `AppError.details` through unchanged.
 */

export type EditorState = {
  workflowId: string;
  versionId: string | null;
  graph: Graph;
  /** Task rows of the published version, by name — absent for a node not yet saved. */
  taskIds: Record<string, string>;
  selected: string | null;
  /** A connection drawn on the canvas, waiting for the user to name its event type. */
  pending: { from: string; to: string } | null;
  dirty: boolean;
  busy: boolean;
  error: ApiError | null;
  notice: string | null;
};

export type EditorStore = ReturnType<typeof createEditorStore>;

const emptyTask = (name: string, kind: NodeKind, at: { x: number; y: number }): GraphTask => ({
  name,
  kind,
  mode: "stub",
  prompt: null,
  limits: {},
  emits: [],
  schedule: null,
  position: at,
});

export function createEditorStore(init: {
  workflowId: string;
  versionId: string | null;
  graph: Graph;
  tasks: TaskSummary[];
}) {
  const store = createStore<EditorState>(() => ({
    workflowId: init.workflowId,
    versionId: init.versionId,
    graph: init.graph,
    taskIds: Object.fromEntries(init.tasks.map((t) => [t.name, t.id])),
    selected: init.graph.tasks[0]?.name ?? null,
    pending: null,
    dirty: false,
    busy: false,
    error: null,
    notice: null,
  }));

  const edit = (fn: (graph: Graph) => Graph): void =>
    store.setState({ graph: fn(store.getState().graph), dirty: true, notice: null });

  const mapTask = (name: string, fn: (task: GraphTask) => GraphTask): void =>
    edit((graph) => ({ ...graph, tasks: graph.tasks.map((t) => (t.name === name ? fn(t) : t)) }));

  return {
    ...store,

    select: (name: string | null) => store.setState({ selected: name }),

    addNode(kind: NodeKind) {
      const { graph } = store.getState();
      let name: string = kind;
      for (let n = 2; graph.tasks.some((t) => t.name === name); n += 1) name = `${kind}-${n}`;
      const at = { x: 60 + graph.tasks.length * 40, y: 60 + graph.tasks.length * 70 };
      edit((g) => ({ ...g, tasks: [...g.tasks, emptyTask(name, kind, at)] }));
      store.setState({ selected: name });
    },

    removeNode(name: string) {
      edit((g) => ({
        tasks: g.tasks.filter((t) => t.name !== name),
        edges: g.edges.filter((e) => e.from !== name && e.to !== name),
      }));
      if (store.getState().selected === name) store.setState({ selected: null });
    },

    /**
     * Renaming carries the edges with it. `tasks.name` is the node's identity across
     * versions, so a rename is genuinely a new node as far as event routing is concerned —
     * worth knowing, not worth blocking.
     */
    renameNode(from: string, to: string) {
      const trimmed = to.trim();
      if (!trimmed || store.getState().graph.tasks.some((t) => t.name === trimmed)) return;
      edit((g) => ({
        tasks: g.tasks.map((t) => (t.name === from ? { ...t, name: trimmed } : t)),
        edges: g.edges.map((e) => ({
          ...e,
          from: e.from === from ? trimmed : e.from,
          to: e.to === from ? trimmed : e.to,
        })),
      }));
      store.setState({ selected: trimmed });
    },

    patchNode: (name: string, patch: Partial<GraphTask>) => mapTask(name, (t) => ({ ...t, ...patch })),

    moveNode: (name: string, position: { x: number; y: number }) =>
      // A drag is a document change like any other, but it must not mark the graph dirty on
      // its own — React Flow emits position changes while merely mounting.
      store.setState({
        graph: {
          ...store.getState().graph,
          tasks: store.getState().graph.tasks.map((t) => (t.name === name ? { ...t, position } : t)),
        },
      }),

    markDirty: () => store.setState({ dirty: true }),

    beginConnect: (from: string, to: string) => store.setState({ pending: { from, to }, notice: null }),
    cancelConnect: () => store.setState({ pending: null }),

    completeConnect(eventType: string) {
      const { pending, graph } = store.getState();
      const type = eventType.trim();
      if (!pending || !type) return;
      const exists = graph.edges.some(
        (e) => e.from === pending.from && e.to === pending.to && e.eventType === type,
      );
      if (!exists) edit((g) => ({ ...g, edges: [...g.edges, { ...pending, eventType: type }] }));
      store.setState({ pending: null });
    },

    removeEdge: (id: string) =>
      edit((g) => ({ ...g, edges: g.edges.filter((e) => edgeId(e) !== id) })),

    async save() {
      if (store.getState().busy) return;
      store.setState({ busy: true, error: null, notice: null });
      try {
        const { workflowId, graph } = store.getState();
        const { versionId, taskIds } = await api.workflow.publishVersion.mutate({ workflowId, graph });
        store.setState({ versionId, taskIds, dirty: false, busy: false, notice: `published ${versionId}` });
      } catch (err) {
        store.setState({ busy: false, error: asApiError(err) });
      }
    },

    /**
     * "Trigger now": publish a synthetic event at the node and let the engine pick the run
     * up. Only offered for a saved node — an unsaved one has no row to trigger.
     */
    async triggerNow(name: string, type: string) {
      const taskId = store.getState().taskIds[name];
      if (!taskId) return;
      store.setState({ busy: true, error: null, notice: null });
      try {
        const result = await api.run.triggerManual.mutate({ taskId, type: type.trim() || undefined });
        store.setState({
          busy: false,
          notice: result.runId ? `triggered — run ${result.runId}` : `emitted ${result.type} (no run created)`,
        });
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
        dirty: false,
        error: null,
        notice: "reloaded",
      });
    },
  };
}

export const edgeId = (e: { from: string; eventType: string; to: string }): string =>
  `${e.from}|${e.eventType}|${e.to}`;

/**
 * Cycles are legal — the loop budget bounds them (§18.6) — but invisible ones are how a
 * workflow quietly burns its hops, so the editor names every one it finds. DFS with the
 * current path on the stack, so the warning can quote the actual cycle rather than "there
 * is a cycle somewhere".
 */
export function findCycles(graph: Graph): string[][] {
  const out = new Map<string, string[]>();
  for (const e of graph.edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);

  const cycles: string[][] = [];
  const seen = new Set<string>();
  const onPath: string[] = [];

  const walk = (node: string): void => {
    const at = onPath.indexOf(node);
    if (at !== -1) {
      cycles.push([...onPath.slice(at), node]);
      return;
    }
    if (seen.has(node)) return;
    seen.add(node);
    onPath.push(node);
    for (const next of out.get(node) ?? []) walk(next);
    onPath.pop();
  };

  for (const task of graph.tasks) walk(task.name);
  return cycles;
}

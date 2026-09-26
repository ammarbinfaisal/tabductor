import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Graph } from "@tabductor/engine";
import { api } from "../lib/api.js";
import { createEditorStore } from "./editor-store.js";

vi.mock("../lib/api.js", () => ({
  api: {
    engine: { status: { query: vi.fn().mockResolvedValue({ executors: [] }) } },
    workflow: {
      get: { query: vi.fn() },
      publishVersion: { mutate: vi.fn() },
      trigger: { mutate: vi.fn() },
      setSchedule: { mutate: vi.fn() },
      compileIntent: { mutate: vi.fn() },
    },
  },
  asApiError: (err: Error) => ({ message: err.message, details: {} }),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

it("runs without crypto.randomUUID and preserves the request ID across a failed request and reload", async () => {
  vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  const init = { workflowId: "wf", versionId: "v1", graph: { tasks: [], events: [] }, tasks: [], eventSchemas: {} };
  const store = createEditorStore(init);
  vi.mocked(api.workflow.trigger.mutate).mockRejectedValueOnce(new Error("Connection interrupted"));

  await store.triggerWorkflow();
  expect(api.workflow.trigger.mutate).toHaveBeenCalledTimes(1);
  const first = vi.mocked(api.workflow.trigger.mutate).mock.calls[0]![0];
  expect(first.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(storage.get("tabductor.trigger.wf")).toBe(first.requestId);
  expect(store.getState()).toMatchObject({ busy: false, error: { message: "Connection interrupted" } });

  const reloaded = createEditorStore(init);
  vi.mocked(api.workflow.trigger.mutate).mockResolvedValue({
    workflowId: "wf", executionId: "exec_1", accepted: 1,
    runs: [{ eventId: "evt", type: "manual.trigger", runId: "run_1" }],
  });
  await reloaded.triggerWorkflow();
  expect(api.workflow.trigger.mutate).toHaveBeenNthCalledWith(2, first);
  expect(storage.has("tabductor.trigger.wf")).toBe(false);
  expect(reloaded.getState()).toMatchObject({ busy: false, error: null, notice: "Queued 1 run from the published workflow." });

  await reloaded.triggerWorkflow();
  expect(vi.mocked(api.workflow.trigger.mutate).mock.calls[2]![0].requestId).not.toBe(first.requestId);
});

const automationGraph: Graph = {
  automationPrompt: "Check the dashboard daily",
  tasks: [{ name: "Read", kind: "browser", mode: "ai", prompt: "Read the dashboard", emits: [], consumes: [], limits: {}, schedule: null, position: null }],
  events: [],
};

it("requires prompt inputs and sends fresh values for each manual run", async () => {
  const graph = { ...automationGraph, automationPrompt: "Write about $topic" };
  const store = createEditorStore({ workflowId: "wf", versionId: "v1", graph, tasks: [], eventSchemas: {} });
  await store.triggerWorkflow();
  expect(api.workflow.trigger.mutate).not.toHaveBeenCalled();
  expect(store.getState().error?.message).toContain("$topic");
  vi.mocked(api.workflow.trigger.mutate).mockResolvedValue({ workflowId: "wf", executionId: "exec", accepted: 0, runs: [] });
  store.setPromptInput("topic", "gardening");
  await store.triggerWorkflow();
  expect(api.workflow.trigger.mutate).toHaveBeenLastCalledWith({ workflowId: "wf", requestId: expect.any(String), inputs: { topic: "gardening" } });
  const firstId = vi.mocked(api.workflow.trigger.mutate).mock.calls[0]![0].requestId;
  store.setPromptInput("topic", "astronomy");
  await store.triggerWorkflow();
  expect(api.workflow.trigger.mutate).toHaveBeenLastCalledWith({ workflowId: "wf", requestId: expect.any(String), inputs: { topic: "astronomy" } });
  expect(vi.mocked(api.workflow.trigger.mutate).mock.calls[1]![0].requestId).not.toBe(firstId);
});

it("restores inputs with uncertain trigger retries and changes the key when inputs change", async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  const init = { workflowId: "wf", versionId: "v1", graph: { ...automationGraph, automationPrompt: "$topic" }, tasks: [], eventSchemas: {} };
  const store = createEditorStore(init);
  store.setPromptInput("topic", "gardening");
  vi.mocked(api.workflow.trigger.mutate).mockRejectedValue(new Error("Connection interrupted"));
  await store.triggerWorkflow();
  const reloaded = createEditorStore(init);
  reloaded.restorePromptInputs();
  expect(reloaded.getState().promptInputs).toEqual({ topic: "gardening" });
  await reloaded.triggerWorkflow();
  expect(vi.mocked(api.workflow.trigger.mutate).mock.calls[1]![0]).toEqual(vi.mocked(api.workflow.trigger.mutate).mock.calls[0]![0]);
  reloaded.setPromptInput("topic", "astronomy");
  await reloaded.triggerWorkflow();
  expect(vi.mocked(api.workflow.trigger.mutate).mock.calls[2]![0].requestId).not.toBe(vi.mocked(api.workflow.trigger.mutate).mock.calls[0]![0].requestId);
});

function mockPublication(graph: Graph) {
  vi.mocked(api.workflow.publishVersion.mutate).mockResolvedValue({ versionId: "v2", taskIds: {}, taskModes: {}, report: { events: [], tasks: [] } });
  vi.mocked(api.workflow.get.query).mockResolvedValue({
    workflow: { id: "wf", accountId: "acct_local", name: "Workflow", maxHops: 20, userId: "user", currentVersionId: "v2", blockedReasonJson: null, deletingAt: null, createdAt: new Date() },
    versionId: "v2", graph, tasks: [], eventSchemas: {}, authoring: { report: null, proposedGrants: [] },
  });
  vi.mocked(api.workflow.compileIntent.mutate).mockResolvedValue({ ok: true, artifact: { graph, store: null, proposedGrants: [] }, report: { checks: [], attempts: 1 } });
}

it.each([null, "v1"])("compiles and publishes a prompt in one action (base version %s)", async (versionId) => {
  const graph: Graph = versionId ? { ...automationGraph, automationPrompt: "Old prompt" } : { tasks: [], events: [] };
  const store = createEditorStore({ workflowId: "wf", versionId, graph, tasks: [], eventSchemas: {} });
  store.setAutomationPrompt("  Check the dashboard daily  ");
  await store.triggerWorkflow();
  expect(api.workflow.trigger.mutate).not.toHaveBeenCalled();
  mockPublication(automationGraph);
  const publishing = store.save();
  expect(store.getState()).toMatchObject({ busy: true, publishing: true });
  await store.save(); // A second click cannot start another compile or publication.
  await publishing;
  expect(api.workflow.compileIntent.mutate).toHaveBeenCalledExactlyOnceWith({ workflowId: "wf", intent: automationGraph.automationPrompt, resultSchema: null, current: { graph, store: null, proposedGrants: [] } });
  expect(api.workflow.publishVersion.mutate).toHaveBeenCalledExactlyOnceWith({ workflowId: "wf", expectedVersionId: versionId, graph: automationGraph, authoring: { report: { checks: [], attempts: 1 }, proposedGrants: [] } });
  expect(store.getState()).toMatchObject({ graph: automationGraph, versionId: "v2", dirty: false, busy: false, publishing: false });
});

it("compiles result schema edits during publish and rejects invalid JSON before any API calls", async () => {
  const store = createEditorStore({ workflowId: "wf", versionId: "v1", graph: automationGraph, tasks: [], eventSchemas: {} });
  store.setResultSchemaText('{"type":"array","items":{"type":"string"}}');
  await store.triggerWorkflow();
  expect(api.workflow.trigger.mutate).not.toHaveBeenCalled();
  mockPublication(automationGraph);
  await store.save();
  expect(api.workflow.compileIntent.mutate).toHaveBeenCalledWith(expect.objectContaining({
    intent: automationGraph.automationPrompt, resultSchema: { type: "array", items: { type: "string" } },
  }));
  expect(api.workflow.publishVersion.mutate).toHaveBeenCalledTimes(1);
  store.setResultSchemaText("invalid JSON");
  await store.save();
  expect(api.workflow.compileIntent.mutate).toHaveBeenCalledTimes(1);
  expect(api.workflow.publishVersion.mutate).toHaveBeenCalledTimes(1);
  expect(store.getState()).toMatchObject({ busy: false, publishing: false, notice: null });
  expect(store.getState().error).not.toBeNull();
});

it("stops publication when prompt compilation fails and retains the prompt for retry", async () => {
  const store = createEditorStore({ workflowId: "wf", versionId: "v1", graph: automationGraph, tasks: [], eventSchemas: {} });
  store.setAutomationPrompt("Updated prompt");
  vi.mocked(api.workflow.compileIntent.mutate).mockResolvedValueOnce({ ok: false, error: "Could not prepare automation", report: { checks: [], attempts: 1 } });
  await store.save();
  expect(api.workflow.publishVersion.mutate).not.toHaveBeenCalled();
  expect(store.getState()).toMatchObject({ graph: automationGraph, automationPrompt: "Updated prompt", versionId: "v1", busy: false, publishing: false, error: { message: "Could not prepare automation" } });
});

it("retries a failed publication without recompiling the prepared automation", async () => {
  const store = createEditorStore({ workflowId: "wf", versionId: null, graph: { tasks: [], events: [] }, tasks: [], eventSchemas: {} });
  store.setAutomationPrompt(automationGraph.automationPrompt!);
  mockPublication(automationGraph);
  vi.mocked(api.workflow.publishVersion.mutate).mockRejectedValueOnce(new Error("Publish failed"));
  await store.save();
  expect(store.getState()).toMatchObject({ dirty: true, versionId: null, busy: false, publishing: false, error: { message: "Publish failed" } });
  await store.triggerWorkflow();
  expect(api.workflow.trigger.mutate).not.toHaveBeenCalled();
  await store.save();
  expect(api.workflow.compileIntent.mutate).toHaveBeenCalledTimes(1);
  expect(api.workflow.publishVersion.mutate).toHaveBeenCalledTimes(2);
  expect(store.getState()).toMatchObject({ dirty: false, versionId: "v2", error: null });
});

it("checks generated share visibility changes and publishes on confirmation without recompiling", async () => {
  const store = createEditorStore({ workflowId: "wf", versionId: null, graph: { tasks: [], events: [] }, tasks: [], eventSchemas: {} });
  const graph = { ...automationGraph, events: [{ type: "shared", description: "Shared result", public: true }] };
  store.setAutomationPrompt(graph.automationPrompt!);
  mockPublication(graph);
  await store.save();
  expect(api.workflow.publishVersion.mutate).not.toHaveBeenCalled();
  expect(store.getState()).toMatchObject({ busy: false, publishing: false, dirty: true, confirmVisibility: { adding: ["shared"], removing: [] } });
  await store.save(true);
  expect(api.workflow.compileIntent.mutate).toHaveBeenCalledTimes(1);
  expect(api.workflow.publishVersion.mutate).toHaveBeenCalledTimes(1);
  expect(store.getState()).toMatchObject({ dirty: false, versionId: "v2", confirmVisibility: null });
});


it("keeps legacy sample nodes as unpublished edits until real execution is published, including after reload", async () => {
  const graph: Graph = {
    tasks: [{ name: "Browser", kind: "browser", mode: "stub", prompt: "Read the page.", limits: {}, emits: [], consumes: [], schedule: null, position: null }],
    events: [],
  };
  const init = {
    workflowId: "wf", versionId: "v1", graph,
    tasks: [{ id: "t1", name: "Browser", kind: "browser", mode: "stub", compiledPrompt: null }],
    eventSchemas: {},
    authoring: { report: null, proposedGrants: [] },
  };
  const store = createEditorStore(init);

  expect(store.getState().graph.tasks[0]?.mode).toBe("ai");
  expect(store.getState().dirty).toBe(true);
  expect(store.getState().notice).toContain("Publish to replace legacy test behavior");
  expect(graph.tasks[0]?.mode).toBe("stub");
  expect(store.getState().publishedTasks.Browser?.mode).toBe("stub");
  expect(api.workflow.publishVersion.mutate).not.toHaveBeenCalled();

  const workflow = { id: "wf", accountId: "acct_local", name: "Workflow", maxHops: 20, userId: "user", currentVersionId: "v1", blockedReasonJson: null, deletingAt: null, createdAt: new Date() };
  vi.mocked(api.workflow.get.query).mockResolvedValue({ ...init, workflow });
  await store.reload();
  expect(store.getState().graph.tasks[0]?.mode).toBe("ai");
  expect(store.getState().dirty).toBe(true);
  expect(api.workflow.publishVersion.mutate).not.toHaveBeenCalled();

  vi.mocked(api.workflow.publishVersion.mutate).mockResolvedValue({ versionId: "v2", taskIds: { Browser: "t2" }, taskModes: { Browser: "ai" }, report: { events: [], tasks: [] } });
  vi.mocked(api.workflow.get.query).mockResolvedValue({
    ...init, workflow: { ...workflow, currentVersionId: "v2" }, versionId: "v2",
    graph: store.getState().graph,
    tasks: [{ ...init.tasks[0]!, id: "t2", mode: "ai" }],
  });
  await store.save();
  expect(api.workflow.publishVersion.mutate).toHaveBeenCalledWith({ workflowId: "wf", expectedVersionId: "v1", graph: { ...graph, tasks: [{ ...graph.tasks[0], mode: "ai" }] } });
  expect(store.getState().dirty).toBe(false);
  expect(store.getState().versionId).toBe("v2");
  expect(store.getState().publishedTasks.Browser?.mode).toBe("ai");
});

it("runs and schedules the published workflow through workflow-level controls", async () => {
  const graph: Graph = {
    tasks: [{
      name: "Internal entry",
      kind: "decision",
      mode: "ai",
      prompt: "Do the work.",
      limits: {},
      emits: [],
      consumes: [],
      schedule: null,
      position: null,
    }],
    events: [],
  };
  const workflow = {
    id: "wf",
    accountId: "acct_local",
    name: "Workflow",
    maxHops: 20,
    userId: "user",
    currentVersionId: "v1",
    blockedReasonJson: null, deletingAt: null,
    createdAt: new Date(),
  };
  const init = {
    workflowId: "wf",
    versionId: "v1",
    graph,
    tasks: [{ id: "task_private", name: "Internal entry", kind: "decision", mode: "ai", compiledPrompt: "Do the work." }],
    eventSchemas: {},
    authoring: { report: null, proposedGrants: [] },
  };
  const store = createEditorStore(init);

  vi.mocked(api.workflow.trigger.mutate).mockResolvedValue({
    workflowId: "wf",
    executionId: "exec_1",
    accepted: 1,
    runs: [{ eventId: "evt", type: "manual.trigger", runId: "run_1" }],
  });
  await store.triggerWorkflow();
  expect(api.workflow.trigger.mutate).toHaveBeenCalledWith({ workflowId: "wf", requestId: expect.any(String) });
  expect(store.getState().notice).toContain("Queued 1 run");

  const scheduledGraph: Graph = {
    ...graph,
    tasks: graph.tasks.map((task) => ({
      ...task,
      schedule: {
        cron: "0 7 * * *",
        tz: "Asia/Kolkata",
        missedPolicy: "skip",
        overlapPolicy: "skip",
        maxQueueDepth: 1,
        enabled: true,
      },
    })),
  };
  store.setScheduleDraft({ cron: "0 7 * * *", timezone: "Asia/Kolkata" });
  vi.mocked(api.workflow.setSchedule.mutate).mockResolvedValue({
    workflowId: "wf",
    versionId: "v2",
    schedule: { cron: "0 7 * * *", timezone: "Asia/Kolkata", enabled: true },
  });
  vi.mocked(api.workflow.get.query).mockResolvedValue({
    ...init,
    workflow: { ...workflow, currentVersionId: "v2" },
    versionId: "v2",
    graph: scheduledGraph,
  });
  await store.publishSchedule();
  expect(api.workflow.setSchedule.mutate).toHaveBeenCalledWith({
    workflowId: "wf",
    schedule: { cron: "0 7 * * *", timezone: "Asia/Kolkata", enabled: true },
  });
  expect(store.getState().versionId).toBe("v2");
  expect(store.getState().scheduleDraft).toEqual({
    cron: "0 7 * * *",
    timezone: "Asia/Kolkata",
    enabled: true,
  });
});

it("restores a local draft only against the same published version", () => {
  const graph: Graph = { tasks: [], events: [{ type: "ready", description: "Ready", public: false }] };
  const saved = { versionId: "v1", dirty: true, graph, authoringStore: null, proposedGrants: [] };
  const storage = { getItem: vi.fn(() => JSON.stringify(saved)), setItem: vi.fn() };
  vi.stubGlobal("localStorage", storage);
  try {
    const store = createEditorStore({ workflowId: "wf", versionId: "v1", graph: { tasks: [], events: [] }, tasks: [], eventSchemas: {} });
    const cleanup = store.restoreDraft();
    expect(store.getState()).toMatchObject({ graph, dirty: true, authoringReport: { checks: [], attempts: 1 } });
    cleanup?.();
    const newer = createEditorStore({ workflowId: "wf", versionId: "v2", graph: { tasks: [], events: [] }, tasks: [], eventSchemas: {} });
    const stop = newer.restoreDraft();
    expect(newer.getState().graph.events).toHaveLength(0);
    stop?.();
  } finally { vi.unstubAllGlobals(); }
});

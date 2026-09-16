import { beforeEach, expect, it, vi } from "vitest";
import type { Graph } from "@tabductor/engine";
import { api } from "../lib/api.js";
import { sendWorkflowMessage } from "../lib/workflow-chat-client.js";
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

vi.mock("../lib/workflow-chat-client.js", () => ({ sendWorkflowMessage: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

it("streams conversational edits without coupling the request to the selected node", async () => {
  const graph: Graph = { tasks: [{ name: "Read", kind: "browser", mode: "ai", prompt: "Read page", emits: [], consumes: [], limits: {}, schedule: null, position: null }], events: [] };
  const store = createEditorStore({ workflowId: "wf", versionId: "v1", graph, tasks: [], eventSchemas: {} });
  store.select({ kind: "node", id: "Read" });
  const updated = { ...graph, tasks: [{ ...graph.tasks[0]!, prompt: "Read page and check totals" }] };
  vi.mocked(sendWorkflowMessage).mockImplementation(async (_input, emit) => {
    emit({ type: "tool", activity: { id: "tool1", label: "Updating draft", status: "running" } });
    emit({ type: "draft", artifact: { graph: updated, store: null, proposedGrants: [] } });
    emit({ type: "text", text: "Added a totals check." });
    emit({ type: "tool", activity: { id: "tool1", label: "Updating draft", status: "complete" } });
    emit({ type: "done" });
  });
  store.setAuthoringIntent("Also check totals");
  await store.sendMessage();
  expect(sendWorkflowMessage).toHaveBeenCalledWith(expect.objectContaining({ current: expect.objectContaining({ graph }), messages: [{ role: "user", text: "Also check totals" }] }), expect.any(Function), expect.any(AbortSignal));
  expect(store.getState()).toMatchObject({ graph: updated, dirty: true, chatPending: false, selected: null });
  expect(store.getState().chatMessages[1]).toMatchObject({ text: "Added a totals check.", tools: [{ id: "tool1", status: "complete" }] });
  expect(api.workflow.publishVersion.mutate).not.toHaveBeenCalled();
  store.setAuthoringIntent("Explain that change");
  await store.sendMessage();
  expect(vi.mocked(sendWorkflowMessage).mock.calls[1]?.[0]).toMatchObject({ current: expect.objectContaining({ graph: updated }), messages: expect.arrayContaining([{ role: "assistant", text: "Added a totals check." }]) });
});

it("retains completed draft changes when a streaming connection fails", async () => {
  const graph: Graph = { tasks: [], events: [] };
  const updated = { tasks: [], events: [{ type: "review", description: "Review", public: false }] };
  const store = createEditorStore({ workflowId: "wf", versionId: null, graph, tasks: [], eventSchemas: {} });
  vi.mocked(sendWorkflowMessage).mockImplementation(async (_input, emit) => {
    emit({ type: "draft", artifact: { graph: updated, store: null, proposedGrants: [] } });
    throw new Error("Connection interrupted");
  });
  store.setAuthoringIntent("Add a review step");
  await store.sendMessage();
  expect(store.getState()).toMatchObject({ graph: updated, dirty: true, chatPending: false, busy: false });
  expect(store.getState().chatMessages[1]?.text).toContain("Connection interrupted");
});

it("refreshes published metadata after chat publishes without publishing a second time", async () => {
  const graph: Graph = { tasks: [], events: [] };
  const store = createEditorStore({ workflowId: "wf", versionId: "v1", graph, tasks: [], eventSchemas: {} });
  vi.mocked(sendWorkflowMessage).mockImplementation(async (_input, emit) => {
    emit({ type: "published", versionId: "v2" });
    emit({ type: "text", text: "Published your changes." });
    emit({ type: "done" });
  });
  vi.mocked(api.workflow.get.query).mockResolvedValue({ workflow: { id: "wf", accountId: "acct_local", name: "Workflow", maxHops: 20, userId: "user", currentVersionId: "v2", createdAt: new Date() }, versionId: "v2", graph, tasks: [], eventSchemas: {}, authoring: { report: null, proposedGrants: [] } });
  store.setAuthoringIntent("Publish the draft");
  await store.sendMessage();
  expect(store.getState()).toMatchObject({ versionId: "v2", dirty: false, busy: false });
  expect(api.workflow.publishVersion.mutate).not.toHaveBeenCalled();
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

  const workflow = { id: "wf", accountId: "acct_local", name: "Workflow", maxHops: 20, userId: "user", currentVersionId: "v1", createdAt: new Date() };
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
  expect(api.workflow.publishVersion.mutate).toHaveBeenCalledWith({ workflowId: "wf", graph: { ...graph, tasks: [{ ...graph.tasks[0], mode: "ai" }] } });
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
  expect(api.workflow.trigger.mutate).toHaveBeenCalledWith({ workflowId: "wf" });
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

it("restores local conversation and its checked draft only against the same published version", () => {
  const graph: Graph = { tasks: [], events: [{ type: "ready", description: "Ready", public: false }] };
  const saved = { versionId: "v1", dirty: true, graph, authoringStore: null, proposedGrants: [], chatMessages: [{ role: "assistant", text: "Updated the draft", tools: [{ id: "tool", label: "Updating draft", status: "running" }] }] };
  const storage = { getItem: vi.fn(() => JSON.stringify(saved)), setItem: vi.fn() };
  vi.stubGlobal("localStorage", storage);
  try {
    const store = createEditorStore({ workflowId: "wf", versionId: "v1", graph: { tasks: [], events: [] }, tasks: [], eventSchemas: {} });
    const cleanup = store.restoreConversation();
    expect(store.getState()).toMatchObject({ graph, dirty: true, authoringReport: { checks: [], attempts: 1 } });
    expect(store.getState().chatMessages[0]?.tools?.[0]?.status).toBe("error");
    cleanup?.();
    const newer = createEditorStore({ workflowId: "wf", versionId: "v2", graph: { tasks: [], events: [] }, tasks: [], eventSchemas: {} });
    const stop = newer.restoreConversation();
    expect(newer.getState().graph.events).toHaveLength(0);
    expect(newer.getState().chatMessages).toHaveLength(1);
    stop?.();
  } finally { vi.unstubAllGlobals(); }
});

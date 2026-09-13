import { beforeEach, expect, it, vi } from "vitest";
import type { Graph } from "@tabductor/engine";
import { api } from "../lib/api.js";
import { createEditorStore } from "./editor-store.js";

vi.mock("../lib/api.js", () => ({
  api: {
    engine: { status: { query: vi.fn().mockResolvedValue({ executors: [], capabilities: [] }) } },
    workflow: {
      get: { query: vi.fn() },
      publishVersion: { mutate: vi.fn() },
    },
  },
  asApiError: (err: Error) => ({ message: err.message, details: {} }),
}));

beforeEach(() => vi.clearAllMocks());

it("keeps legacy sample nodes as unpublished edits until real execution is published, including after reload", async () => {
  const graph: Graph = {
    tasks: [{ name: "Browser", kind: "browser", mode: "stub", prompt: "Read the page.", limits: {}, emits: [], consumes: [], schedule: null, position: null }],
    events: [],
  };
  const init = {
    workflowId: "wf", versionId: "v1", graph,
    tasks: [{ id: "t1", name: "Browser", kind: "browser", mode: "stub", compiledPrompt: null }],
    eventSchemas: {},
  };
  const store = createEditorStore(init);

  expect(store.getState().graph.tasks[0]?.mode).toBe("ai");
  expect(store.getState().dirty).toBe(true);
  expect(store.getState().notice).toContain("Publish to enable real execution");
  expect(graph.tasks[0]?.mode).toBe("stub");
  expect(store.getState().publishedTasks.Browser?.mode).toBe("stub");
  expect(api.workflow.publishVersion.mutate).not.toHaveBeenCalled();

  const workflow = { id: "wf", name: "Workflow", maxHops: 20, userId: "user", currentVersionId: "v1", createdAt: new Date() };
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

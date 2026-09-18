import { expect, it, vi } from "vitest";
import { AppError } from "@tabductor/core";
import { runWorkflowChat, type WorkflowChatEvent, type WorkflowChatInput, type WorkflowChatModel } from "./workflow-chat.js";
import type { GraphCompileResult, GraphDraftArtifact } from "./graph-authoring.js";

const original: GraphDraftArtifact = { graph: { tasks: [], events: [] }, store: null, proposedGrants: [] };
const edited: GraphDraftArtifact = { ...original, graph: { tasks: [], events: [{ type: "review.ready", description: "A review with a title", summary: "A review ready for the team.", label: "Review ready", public: false }] } };
const request: WorkflowChatInput = { workflowId: "wf", versionId: "v1", current: original, messages: [{ role: "user", text: "Add a review event and publish" }] };
const editCall = { id: "edit", name: "mutate_graph", args: { operation: "add_event", target: "review.ready", instruction: "Add a review event carrying a title" } };
const publishCall = { id: "publish", name: "publish_draft", args: {} };
const success: GraphCompileResult = { ok: true, artifact: edited, report: { checks: [], attempts: 1 } };

it.each([
  ["model_selection_missing", "/settings/models"],
  ["model_credential_missing", "unavailable or revoked"],
  ["credit_insufficient", "not enough available credits"],
  ["model_operation_uncertain", "Check model usage in Billing before retrying"],
])("explains %s without exposing exception details", async (code, expected) => {
  const events: WorkflowChatEvent[] = [];
  const privateValue = "private-provider-key-and-prompt";
  const complete = vi.fn().mockRejectedValue(new AppError(code, privateValue, { cause: new Error(privateValue), details: { key: privateValue } }));
  const compiler = { compile: vi.fn() };
  const publish = vi.fn();
  await runWorkflowChat(request, { model: { complete }, compiler, publish, gateContext: {}, onEvent: (event) => events.push(event) });
  expect(events).toEqual([{ type: "error", message: expect.stringContaining(expected) }, { type: "done" }]);
  expect(JSON.stringify(events)).not.toContain(privateValue);
  expect(compiler.compile).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
});

it("keeps completed drafts and hides unknown provider errors", async () => {
  const events: WorkflowChatEvent[] = [];
  const complete = vi.fn().mockResolvedValueOnce({ text: "", toolCalls: [editCall] })
    .mockRejectedValueOnce(new Error("private-provider-key-and-prompt"));
  await runWorkflowChat(request, { model: { complete }, compiler: { compile: vi.fn().mockResolvedValue(success) },
    publish: vi.fn(), gateContext: {}, onEvent: (event) => events.push(event) });
  expect(events).toContainEqual({ type: "draft", artifact: edited });
  expect(events.at(-2)).toEqual({ type: "error", message: expect.stringContaining("Your completed changes are retained") });
  expect(events.at(-1)).toEqual({ type: "done" });
  expect(JSON.stringify(events)).not.toContain("private-provider-key-and-prompt");
});

it("answers a question without invoking compilation or publication", async () => {
  const compiler = { compile: vi.fn() };
  const publish = vi.fn();
  const events: WorkflowChatEvent[] = [];
  const model: WorkflowChatModel = { complete: vi.fn(async (input) => { input.onText("This workflow is empty."); return { text: "This workflow is empty.", toolCalls: [] }; }) };
  await runWorkflowChat({ ...request, messages: [{ role: "user", text: "What does this workflow do?" }] }, { model, compiler, publish, gateContext: {}, onEvent: (event) => events.push(event) });
  expect(compiler.compile).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  expect(events).toEqual([{ type: "text", text: "This workflow is empty." }, { type: "done" }]);
});

it("applies a checked draft, publishes that exact artifact, and reports tool results to the conversation", async () => {
  const compiler = { compile: vi.fn().mockResolvedValue(success) };
  const publish = vi.fn().mockResolvedValue({ versionId: "v2" });
  const events: WorkflowChatEvent[] = [];
  const complete = vi.fn<WorkflowChatModel["complete"]>()
    .mockResolvedValueOnce({ text: "", toolCalls: [editCall, publishCall] })
    .mockImplementationOnce(async (input) => {
      expect(input.tools.map((tool) => tool.name)).toEqual(["inspect_workflow"]);
      expect(input.messages.some((message) => message.role === "tool")).toBe(true);
      input.onText("The review event is now published.");
      return { text: "The review event is now published.", toolCalls: [] };
    });
  await runWorkflowChat(request, { model: { complete }, compiler, publish, gateContext: {}, onEvent: (event) => events.push(event) });
  expect(compiler.compile).toHaveBeenCalledWith(expect.objectContaining({ current: original, intent: expect.stringContaining("add_event") }));
  expect(publish).toHaveBeenCalledExactlyOnceWith(edited, "v1");
  expect(events.find((event) => event.type === "draft")).toEqual({ type: "draft", artifact: edited });
  expect(events.filter((event) => event.type === "published")).toEqual([{ type: "published", versionId: "v2" }]);
  expect(events.filter((event) => event.type === "tool").map((event) => event.activity.status)).toEqual(["running", "complete", "running", "complete"]);
});

it("does not publish an old graph after a requested edit fails, and allows repair", async () => {
  const compiler = { compile: vi.fn().mockResolvedValueOnce({ ok: false, error: "Missing producer", report: { checks: [], attempts: 1 } }).mockResolvedValueOnce(success) };
  const publish = vi.fn().mockResolvedValue({ versionId: "v2" });
  const events: WorkflowChatEvent[] = [];
  const complete = vi.fn<WorkflowChatModel["complete"]>()
    .mockResolvedValueOnce({ text: "", toolCalls: [editCall, publishCall] })
    .mockImplementationOnce(async () => {
      expect(publish).not.toHaveBeenCalled();
      return { text: "", toolCalls: [{ ...editCall, id: "repair" }, { ...publishCall, id: "publish2" }] };
    }).mockResolvedValueOnce({ text: "", toolCalls: [] });
  await runWorkflowChat(request, { model: { complete }, compiler, publish, gateContext: {}, onEvent: (event) => events.push(event) });
  expect(publish).toHaveBeenCalledExactlyOnceWith(edited, "v1");
  expect(events.filter((event) => event.type === "tool" && event.activity.status === "error")).toHaveLength(2);
});

it("stops before publication when cancelled during compilation", async () => {
  const abort = new AbortController();
  const compiler = { compile: vi.fn(async () => { abort.abort(); return success; }) };
  const publish = vi.fn();
  const complete = vi.fn<WorkflowChatModel["complete"]>().mockResolvedValue({ text: "", toolCalls: [editCall, publishCall] });
  await runWorkflowChat(request, { model: { complete }, compiler, publish, gateContext: {}, signal: abort.signal, onEvent: () => {} });
  expect(publish).not.toHaveBeenCalled();
});

it.each(["add_node", "update_node", "remove_node", "add_packet", "update_packet", "remove_packet", "remove_event", "rewire"])("routes %s through the checked compiler with existing context", async (operation) => {
  const compile = vi.fn().mockResolvedValue(success);
  const complete = vi.fn<WorkflowChatModel["complete"]>().mockResolvedValueOnce({ text: "", toolCalls: [{ ...editCall, args: { ...editCall.args, operation } }] }).mockResolvedValueOnce({ text: "", toolCalls: [] });
  await runWorkflowChat(request, { model: { complete }, compiler: { compile }, publish: vi.fn(), gateContext: { maxHops: 20 }, onEvent: () => {} });
  expect(compile).toHaveBeenCalledWith(expect.objectContaining({ current: original, gateContext: { maxHops: 20 }, intent: expect.stringContaining(operation) }));
});

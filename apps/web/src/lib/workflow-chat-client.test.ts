import { afterEach, expect, it, vi } from "vitest";
import { sendWorkflowMessage } from "./workflow-chat-client.js";
import type { WorkflowChatEvent, WorkflowChatInput } from "@tabductor/engine";

const input: WorkflowChatInput = { workflowId: "wf", versionId: null, current: { graph: { tasks: [], events: [] }, store: null, proposedGrants: [] }, messages: [{ role: "user", text: "Explain" }] };
afterEach(() => vi.unstubAllGlobals());
it("decodes text and draft updates across arbitrary UTF-8 and line boundaries", async () => {
  const events: WorkflowChatEvent[] = [{ type: "text", text: "Café → review" }, { type: "draft", artifact: input.current }, { type: "done" }];
  const bytes = new TextEncoder().encode(events.map((event) => JSON.stringify(event)).join("\n"));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close(); } }))));
  const received: WorkflowChatEvent[] = [];
  await sendWorkflowMessage(input, (event) => received.push(event), new AbortController().signal);
  expect(received).toEqual(events);
});
it("reports a broken stream without losing updates already received", async () => {
  const received: WorkflowChatEvent[] = [];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ type: "draft", artifact: input.current }) + "\n")));
  await expect(sendWorkflowMessage(input, (event) => received.push(event), new AbortController().signal)).rejects.toThrow("connection ended");
  expect(received).toHaveLength(1);
});

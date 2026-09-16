import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { graphSchema, staticSchemaGenerator, type GraphDraftArtifact, type WorkflowChatEvent, type WorkflowChatModel } from "@tabductor/engine";
import type { Context } from "../../apps/web/src/server/trpc.js";

const holder = vi.hoisted(() => ({ ctx: null as unknown as Context, model: null as unknown as WorkflowChatModel }));
vi.mock("../../apps/web/src/server/trpc.js", async (original) => ({ ...await original<typeof import("../../apps/web/src/server/trpc.js")>(), createContext: () => holder.ctx }));
vi.mock("../../apps/web/src/server/schema-generator.js", async (original) => ({ ...await original<typeof import("../../apps/web/src/server/schema-generator.js")>(), workflowChatModel: () => holder.model }));
import { POST } from "../../apps/web/src/app/api/workflow-chat/route.js";
import { createCaller } from "../../apps/web/src/server/router.js";

let handle: MigratedTestDb;
const artifact: GraphDraftArtifact = { graph: graphSchema.parse({ tasks: [{ name: "Read title", label: "Read page title", summary: "Collects the title of the example page.", kind: "browser", mode: "ai", prompt: "Open https://example.com, read the page title and emit page.read with title.", emits: ["page.read"] }], events: [{ type: "page.read", label: "Page title", summary: "The title collected from a page.", description: "An object with a required title string.", public: false }] }), store: null, proposedGrants: [] };
beforeAll(async () => {
  handle = await createMigratedTestDb();
  holder.ctx = { db: handle.db, pool: handle.pool, schemaGenerator: staticSchemaGenerator({ "page.read": { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false } }), graphCompiler: { compile: vi.fn().mockResolvedValue({ ok: true, artifact, report: { checks: [], attempts: 1 } }) } };
});
afterAll(async () => { await handle?.close(); });

it("streams a checked edit and publishes it through the actual API, then rejects a stale conversation", async () => {
  const api = createCaller(holder.ctx);
  const workflowId = await api.workflow.create({ name: "Chat publication test" });
  holder.model = { complete: vi.fn<WorkflowChatModel["complete"]>()
    .mockResolvedValueOnce({ text: "", toolCalls: [
      { id: "edit", name: "mutate_graph", args: { operation: "add_node", target: "Read title", instruction: "Read example.com title and create an output event" } },
      { id: "publish", name: "publish_draft", args: {} },
    ] }).mockImplementationOnce(async (input) => { input.onText("Published the page reader."); return { text: "Published the page reader.", toolCalls: [] }; }),
  };
  const body = { workflowId, versionId: null, current: { graph: { tasks: [], events: [] }, store: null, proposedGrants: [] }, messages: [{ role: "user", text: "Add a page reader and publish it" }] };
  const request = () => new Request("http://localhost/api/workflow-chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/x-ndjson");
  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as WorkflowChatEvent);
  expect(events.find((event) => event.type === "draft")).toMatchObject({ artifact });
  expect(events.find((event) => event.type === "published")).toBeDefined();
  expect(events.at(-1)).toEqual({ type: "done" });
  const published = await api.workflow.get({ id: workflowId });
  expect(published.graph.tasks[0]).toMatchObject({ name: "Read title", summary: "Collects the title of the example page." });
  expect(published.eventSchemas["page.read"]).toMatchObject({ required: ["title"] });
  const stale = await POST(request());
  expect(stale.status).toBe(409);
  expect((await api.workflow.get({ id: workflowId })).versionId).toBe(published.versionId);
});

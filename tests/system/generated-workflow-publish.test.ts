import { afterEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { eventDefs } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { createWorkflow, llmGraphCompiler, publishVersion, readGraph } from "@tabductor/engine";
import { llmSchemaGenerator } from "../../packages/engine/src/schema-generator-llm.js";

let handle: MigratedTestDb | undefined;
afterEach(async () => { await handle?.close(); });

it("publishes a built workflow when both graph and event schema output contain trailing commas", async () => {
  handle = await createMigratedTestDb();
  const intent = "Read example.com and report its title";
  const prompt = 'Read the page title, preserving literal ,} and ,] and "quotes".';
  const output = JSON.stringify({
    graph: {
      intent: { requirements: [{ id: "read", description: intent, quote: intent, category: "source" }] },
      tasks: [{ name: "Read page", kind: "browser", mode: "ai", prompt,
        limits: { harness: { version: 1, role: "source", requirementIds: ["read"] } },
        emits: ["page.read"], consumes: [] }],
      events: [{ type: "page.read", description: "The page title", public: false }],
    },
    store: null,
    proposedGrants: [],
  });
  const built = await llmGraphCompiler({ complete: async () => ({ text: output.slice(0, -1) + ",}" }) })
    .compile({ intent });
  expect(built.ok).toBe(true);
  if (!built.ok) throw new Error(built.error);
  const workflowId = await createWorkflow(handle.db, { name: "Generated JSON publication", userId: "test" });
  const published = await publishVersion(handle.db, {
    workflowId, expectedVersionId: null, graph: built.artifact.graph,
    authoring: { report: built.report, proposedGrants: [] },
  }, { schemaGenerator: llmSchemaGenerator({ complete: async () => ({
    text: '{"type":"object","properties":{"title":{"type":"string",},},"required":["title",],"additionalProperties":false,}',
  }) }) });
  expect(published.report.events).toEqual([{ type: "page.read", status: "generated" }]);
  expect((await readGraph(handle.db, published.versionId)).tasks[0]!.prompt).toBe(prompt);
  const [event] = await handle.db.select().from(eventDefs).where(eq(eventDefs.workflowVersionId, published.versionId));
  expect(event!.packetSchemaJson).toEqual({ type: "object", properties: { title: { type: "string" } },
    required: ["title"], additionalProperties: false });
});

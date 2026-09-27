import { afterAll, beforeAll, expect, it } from "vitest";
import { Ajv } from "ajv";
import { eq } from "drizzle-orm";
import { eventDefs, workflows, workflowVersions } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { createWorkflow } from "@tabductor/engine";
import { graphSchema, publishVersion, type SchemaGenerator, type SchemaGenInput } from "@tabductor/engine/testing";
import { bindIntent } from "../../packages/engine/src/intent-contract.js";

let handle: MigratedTestDb;
beforeAll(async () => { handle = await createMigratedTestDb(); });
afterAll(async () => { await handle?.close(); });

// Reproduces the generated tweet workflow: an optional raw ID, a separate derived
// dedupe key, a skip branch, and destination outcomes passing through another step.
const graph = graphSchema.parse({
  tasks: [
    { name: "Collect", emits: ["tweet.extracted"] },
    { name: "Prepare tweet for saving", kind: "decision", consumes: ["tweet.extracted"], emits: ["notion.requested", "tweet.skip"] },
    { name: "Save", consumes: ["notion.requested"], emits: ["notion.saved", "notion.failed"] },
    { name: "Record outcome", kind: "decision", consumes: ["notion.saved", "notion.failed"], emits: ["tweet.outcome"] },
  ],
  events: ["tweet.extracted", "notion.requested", "tweet.skip", "notion.saved", "notion.failed", "tweet.outcome"]
    .map(type => ({ type, description: "Raw tweet_id when available, URL, nullable engagement and quote status." })),
});
const source = {
  type: "object", additionalProperties: false,
  properties: { tweet_id: { type: ["string", "null"] }, tweet_url: { type: "string" },
    likes_count: { type: ["integer", "null"] }, is_quote_or_repost: { type: ["integer", "null"] } },
  required: ["tweet_url", "likes_count", "is_quote_or_repost"],
};
const destination = {
  type: "object", additionalProperties: false,
  properties: { tweet_id: { type: "string" }, tweet_url: { type: "string" }, notion_dedupe_key: { type: "string" },
    likes_count: { type: "integer" }, is_quote_or_repost: { type: "boolean" } },
  required: ["tweet_id", "tweet_url", "notion_dedupe_key", "likes_count", "is_quote_or_repost"],
};

function repairGenerator(extracted: Record<string, unknown> = source) {
  const calls: SchemaGenInput[] = [];
  const generator: SchemaGenerator = { async generate(input) {
    calls.push(input);
    if (!input.compatibility) return { ok: true, schema: input.eventType === "tweet.extracted" ? extracted : destination };
    const schema = structuredClone(input.compatibility.previousSchema);
    const properties = schema.properties as Record<string, unknown>;
    for (const upstream of input.compatibility.upstream) {
      for (const [field, value] of Object.entries(upstream.schema.properties as Record<string, unknown>)) {
        if (!(field in properties)) continue;
        properties[field] = value;
        if (!(upstream.schema.required as string[]).includes(field)) {
          schema.required = (schema.required as string[]).filter(key => key !== field);
        }
      }
    }
    return { ok: true, schema };
  } };
  return { calls, generator };
}

it("repairs nullable tweet schemas across branches and outcome steps, then reuses the result", async () => {
  const workflowId = await createWorkflow(handle.db, { name: "Tweet contract repair", userId: "local" });
  const compiler = repairGenerator();
  const published = await publishVersion(handle.db, { workflowId, graph }, { schemaGenerator: compiler.generator });
  expect(compiler.calls.filter(call => call.compatibility).map(call => call.eventType).sort())
    .toEqual(graph.events.map(event => event.type).filter(type => type !== "tweet.extracted").sort());
  const preparation = compiler.calls.find(call => call.eventType === "notion.requested" && call.compatibility)!;
  expect(preparation.compatibility!.errors).toEqual(expect.arrayContaining([
    expect.stringContaining("tweet_id loses unknown/null values"),
    expect.stringContaining("is_quote_or_repost changes a shared field's type"),
  ]));
  const rows = await handle.db.select().from(eventDefs).where(eq(eventDefs.workflowVersionId, published.versionId));
  const ajv = new Ajv({ strict: true });
  for (const row of rows) {
    const validate = ajv.compile(row.packetSchemaJson as object);
    const packet = { tweet_url: "https://x.test/status/123", likes_count: null, is_quote_or_repost: 1,
      ...(row.eventType === "tweet.extracted" ? {} : { notion_dedupe_key: "url:123" }) };
    expect(validate({ ...packet, tweet_id: null }), row.eventType).toBe(true);
    expect(validate(packet), row.eventType).toBe(true);
  }
  compiler.calls.length = 0;
  const reused = await publishVersion(handle.db, { workflowId, graph }, { schemaGenerator: compiler.generator });
  expect(compiler.calls).toHaveLength(0);
  expect(reused.report.events.every(event => event.status === "reused")).toBe(true);

  // A changed upstream schema must also repair previously cached downstream schemas.
  const changed = structuredClone(graph);
  changed.events.find(event => event.type === "tweet.extracted")!.description += " Quote status is now boolean or null.";
  const recompiler = repairGenerator({ ...source, properties: { ...source.properties, is_quote_or_repost: { type: ["boolean", "null"] } } });
  await publishVersion(handle.db, { workflowId, graph: changed }, { schemaGenerator: recompiler.generator });
  expect(recompiler.calls.filter(call => !call.compatibility).map(call => call.eventType)).toEqual(["tweet.extracted"]);
  expect(recompiler.calls.filter(call => call.compatibility)).toHaveLength(5);
});

it("bounds unsuccessful repairs, reports all conflicts, and leaves the published version intact", async () => {
  const workflowId = await createWorkflow(handle.db, { name: "Broken repair", userId: "local" });
  const first = await publishVersion(handle.db, { workflowId, graph }, { schemaGenerator: repairGenerator().generator });
  const changed = structuredClone(graph);
  changed.tasks[0]!.prompt = "Changed extraction instructions";
  const attempts: string[] = [];
  const generator: SchemaGenerator = { async generate(input) {
    attempts.push(input.eventType);
    // A changed source type makes even the cached, previously repaired destinations incompatible.
    return { ok: true, schema: input.eventType === "tweet.extracted"
      ? { ...source, properties: { ...source.properties, tweet_id: { type: ["integer", "null"] } } }
      : destination };
  } };
  const error = await publishVersion(handle.db, { workflowId, graph: changed }, { schemaGenerator: generator }).catch((err: unknown) => err);
  expect(error).toMatchObject({ code: "record_schema_narrowing", details: { report: { events: expect.arrayContaining([
    expect.objectContaining({ type: "notion.requested", status: "failed", error: expect.stringContaining("tweet_id") }),
  ]) } } });
  for (const type of new Set(attempts)) expect(attempts.filter(value => value === type).length).toBeLessThanOrEqual(3);
  const [workflow] = await handle.db.select().from(workflows).where(eq(workflows.id, workflowId));
  expect(workflow!.currentVersionId).toBe(first.versionId);
  expect(await handle.db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, workflowId))).toHaveLength(1);
});

it("rejects a repair that hides the incompatible fields by dropping them", async () => {
  const workflowId = await createWorkflow(handle.db, { name: "Dropped repair fields", userId: "local" });
  const generator: SchemaGenerator = { async generate(input) {
    return { ok: true, schema: input.compatibility ? { type: "object", properties: {} }
      : input.eventType === "tweet.extracted" ? source : destination };
  } };
  await expect(publishVersion(handle.db, { workflowId, graph }, { schemaGenerator: generator })).rejects.toMatchObject({
    code: "graph_compile_failed", details: { report: { events: expect.arrayContaining([
      expect.objectContaining({ type: "notion.requested", status: "failed", error: expect.stringContaining("removed declared fields") }),
    ]) } },
  });
  expect(await handle.db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, workflowId))).toHaveLength(0);
});

it("compiles ordinary event schemas without hidden destination envelopes or readiness overrides", async () => {
  const workflowId = await createWorkflow(handle.db, { name: "General browser tasks", userId: "local" });
  const request = "Read and update the website";
  const draft = graphSchema.parse({automationPrompt:request, intent:bindIntent(request, {
    requirements:[{id:"work",description:request,quote:request}],
  }), tasks:[{name:"Browse",kind:"browser",entry:true,emits:["destination.ready"],limits:{harness:{version:1,
    requirementIds:["work"],role:"write-record",destination:{readyEvent:"destination.ready",contractField:"contract_id",requiredFields:["unwanted"]}}}}],
    events:[{type:"destination.ready",description:"The actual observed page title"}]});
  const schema = {type:"object",properties:{title:{type:"string"}},required:["title"],additionalProperties:false};
  const calls: SchemaGenInput[] = [];
  const generator: SchemaGenerator = {async generate(input) {calls.push(input);return {ok:true,schema};}};
  const published = await publishVersion(handle.db, {workflowId,graph:draft}, {schemaGenerator:generator});
  expect(calls).toHaveLength(1);
  expect(calls[0]!.description).not.toContain("Host destination envelope");
  const [event] = await handle.db.select().from(eventDefs).where(eq(eventDefs.workflowVersionId,published.versionId));
  expect(event!.packetSchemaJson).toEqual(schema);
  await publishVersion(handle.db, {workflowId,graph:draft}, {schemaGenerator:generator});
  expect(calls).toHaveLength(1);
});

import { afterAll, beforeAll, expect, it } from "vitest";
import { storeSchemas, taskGrants, tasks, workflowVersions, workflows } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { createWorkflow } from "@tabductor/engine";
import { gateGraphDraft, publishVersion, readGraphAuthoring, staticSchemaGenerator, type GraphDraftArtifact } from "@tabductor/engine/testing";
import { addBaselineRule, decideProposedGrant, grantTask, revokeTaskGrant } from "@tabductor/policy";
import { deprovision } from "@tabductor/store";
import { eq } from "drizzle-orm";
import { createCaller } from "../../apps/web/src/server/router.js";
import { CANDIDATES_VISITED_DDL, CANDIDATES_VISITED_SPEC } from "./store-support.js";

let handle: MigratedTestDb;

beforeAll(async () => {
  handle = await createMigratedTestDb();
});

it("migrates a compiled store artifact during publication and pins its schema version", async () => {
  const workflowId = await createWorkflow(handle.db, { name: "Store authored", userId: "user_store_authoring" });
  try {
    const draft: GraphDraftArtifact = {
      graph: {
        tasks: [{
          name: "plan",
          kind: "decision",
          mode: "ai",
          prompt: "Query candidates and emit work.",
          limits: {},
          emits: ["work.ready"],
          consumes: [],
          schedule: null,
          position: null,
        }],
        events: [{ type: "work.ready", description: "A candidate ready for work.", public: false }],
      },
      store: {
        description: "Candidate and visited records.",
        ddl: CANDIDATES_VISITED_DDL,
        tablesSpec: CANDIDATES_VISITED_SPEC,
        confirmDestructive: false,
        forceDestructive: false,
      },
      proposedGrants: [],
    };
    const gated = await gateGraphDraft(draft, { pool: handle.pool, maxHops: 20 });
    expect(gated.checks.some((check) => check.status === "fail")).toBe(false);
    const published = await publishVersion(handle.db, {
      workflowId,
      graph: gated.artifact.graph,
      authoring: {
        report: { checks: gated.checks, attempts: 1 },
        proposedGrants: [],
        store: gated.artifact.store!,
      },
    }, { schemaGenerator: staticSchemaGenerator(), pool: handle.pool });

    const [version] = await handle.db.select().from(workflowVersions).where(eq(workflowVersions.id, published.versionId));
    const [schema] = await handle.db.select().from(storeSchemas).where(eq(storeSchemas.workflowId, workflowId));
    expect(version!.storeSchemaId).toBe(schema!.id);

    const [firstTask] = await handle.db.select().from(tasks).where(eq(tasks.workflowVersionId, published.versionId));
    const firstHash = firstTask!.contentHash;
    const expandedStore: GraphDraftArtifact["store"] = {
      ...draft.store!,
      ddl: `${CANDIDATES_VISITED_DDL}\nCREATE TABLE audit (id text PRIMARY KEY);`,
      tablesSpec: {
        ...CANDIDATES_VISITED_SPEC,
        audit: {
          primaryKey: ["id"],
          schema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
    };
    const expanded = await gateGraphDraft({ ...draft, store: expandedStore }, {
      pool: handle.pool,
      maxHops: 20,
      previousStoreDdl: CANDIDATES_VISITED_DDL,
    });
    const second = await publishVersion(handle.db, {
      workflowId,
      graph: expanded.artifact.graph,
      authoring: {
        report: { checks: expanded.checks, attempts: 1 },
        proposedGrants: [],
        store: expanded.artifact.store!,
      },
    }, { schemaGenerator: staticSchemaGenerator(), pool: handle.pool });
    const [secondVersion] = await handle.db.select().from(workflowVersions).where(eq(workflowVersions.id, second.versionId));
    expect(secondVersion!.storeSchemaId).not.toBe(version!.storeSchemaId);

    // Updating an old-version task after the store advances must hash against that task's
    // pinned schema, not whichever schema happens to be latest for the workflow.
    await grantTask(handle.db, firstTask!.id, { grantKey: "store.write", grantValue: "candidates" });
    await revokeTaskGrant(handle.db, firstTask!.id, "store.write", "candidates");
    const [refreshedFirstTask] = await handle.db.select().from(tasks).where(eq(tasks.id, firstTask!.id));
    expect(refreshedFirstTask!.contentHash).toBe(firstHash);
  } finally {
    await deprovision(handle.pool, workflowId);
  }
});

afterAll(async () => {
  await handle?.close();
});

const artifact: GraphDraftArtifact = {
  graph: {
    tasks: [
      {
        name: "watch",
        kind: "browser",
        mode: "ai",
        prompt: "Open example.com, click the result, and emit page.read.",
        limits: {},
        emits: ["page.read"],
        consumes: [],
        schedule: null,
        position: null,
      },
    ],
    events: [{ type: "page.read", description: "The page title and URL.", public: false }],
  },
  store: null,
  proposedGrants: [
    { taskRef: "watch", grantKey: "navigation", grantValue: "example.com", requiresApproval: false, status: "pending" },
    { taskRef: "watch", grantKey: "action", grantValue: "click", requiresApproval: false, status: "pending" },
  ],
};

it("persists one combined report while proposals remain inert until individually approved", async () => {
  const userId = "user_graph_authoring";
  const workflowId = await createWorkflow(handle.db, { name: "Authored", userId });
  const gated = await gateGraphDraft(artifact, { maxHops: 20 });
  expect(gated.checks.some((check) => check.status === "fail")).toBe(false);

  const published = await publishVersion(
    handle.db,
    {
      workflowId,
      graph: gated.artifact.graph,
      authoring: {
        report: { checks: gated.checks, attempts: 1 },
        proposedGrants: gated.artifact.proposedGrants,
      },
    },
    { schemaGenerator: staticSchemaGenerator() },
  );

  const taskRows = await handle.db.select().from(tasks).where(eq(tasks.workflowVersionId, published.versionId));
  expect(await handle.db.select().from(taskGrants).where(eq(taskGrants.taskId, taskRows[0]!.id))).toEqual([]);

  const authored = await readGraphAuthoring(handle.db, published.versionId);
  expect(authored.report?.publish.events).toEqual([{ type: "page.read", status: "generated" }]);
  expect(authored.proposedGrants.map((grant) => grant.status)).toEqual(["pending", "pending"]);

  await addBaselineRule(handle.db, userId, { effect: "deny", grantKey: "navigation", value: "example.com" });
  await expect(decideProposedGrant(handle.db, authored.proposedGrants[0]!.id, "approved")).resolves.toMatchObject({
    outcome: "stripped_by_baseline",
  });
  await expect(decideProposedGrant(handle.db, authored.proposedGrants[1]!.id, "approved")).resolves.toMatchObject({
    outcome: "approved",
  });

  const grants = await handle.db.select().from(taskGrants).where(eq(taskGrants.taskId, taskRows[0]!.id));
  expect(grants.map((grant) => [grant.grantKey, grant.grantValue])).toEqual([["action", "click"]]);
  const [approvedTask] = await handle.db.select().from(tasks).where(eq(tasks.id, taskRows[0]!.id));

  const decided = await readGraphAuthoring(handle.db, published.versionId);
  const second = await publishVersion(
    handle.db,
    {
      workflowId,
      graph: artifact.graph,
      authoring: {
        report: { checks: gated.checks, attempts: 1 },
        proposedGrants: decided.proposedGrants,
      },
    },
    { schemaGenerator: staticSchemaGenerator() },
  );
  const secondTasks = await handle.db.select().from(tasks).where(eq(tasks.workflowVersionId, second.versionId));
  const secondGrants = await handle.db.select().from(taskGrants).where(eq(taskGrants.taskId, secondTasks[0]!.id));
  expect(secondGrants.map((grant) => [grant.grantKey, grant.grantValue])).toEqual([["action", "click"]]);
  expect(secondTasks[0]!.contentHash).toBe(approvedTask!.contentHash);
  expect((await readGraphAuthoring(handle.db, second.versionId)).proposedGrants.map((grant) => grant.status)).toEqual([
    "stripped_by_baseline",
    "approved",
  ]);
});

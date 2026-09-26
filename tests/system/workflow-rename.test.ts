import { afterAll, beforeAll, expect, it } from "vitest";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { createWorkflow, seedWorkflow, resolveAccountIdentity, requestWorkflowDeletion, staticSchemaGenerator } from "@tabductor/engine";
import { createCaller } from "../../apps/web/src/server/router.js";

let db: MigratedTestDb, owner: string, other: string;
const caller = (accountId: string) => createCaller({ db: db.db, pool: db.pool, accountId, schemaGenerator: staticSchemaGenerator({}) });
beforeAll(async () => {
  db = await createMigratedTestDb();
  owner = await resolveAccountIdentity(db.db, { provider: "fixture", subject: "rename-owner" });
  other = await resolveAccountIdentity(db.db, { provider: "fixture", subject: "rename-other" });
});
afterAll(async () => { await db?.close(); });

it("renames a published workflow without changing its graph or version", async () => {
  const workflowId = await createWorkflow(db.db, { accountId: owner, userId: "fixture", name: "Original" });
  await seedWorkflow(db.db, { workflowId, tasks: { Browse: { kind: "browser", mode: "ai" } } });
  const before = await caller(owner).workflow.get({ id: workflowId });
  expect(await caller(owner).workflow.rename({ workflowId, name: "  New workflow name  " })).toEqual({ name: "New workflow name" });
  const after = await caller(owner).workflow.get({ id: workflowId });
  expect(after.workflow.name).toBe("New workflow name");
  expect(after.versionId).toBe(before.versionId);
  expect(after.graph).toEqual(before.graph);
  await expect(caller(other).workflow.rename({ workflowId, name: "Foreign" })).rejects.toThrow();
  for (const name of ["", "   ", "x".repeat(201)]) {
    await expect(caller(owner).workflow.rename({ workflowId, name })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
  expect((await caller(owner).workflow.get({ id: workflowId })).workflow.name).toBe("New workflow name");
  await requestWorkflowDeletion(db.db, owner, workflowId);
  await expect(caller(owner).workflow.rename({ workflowId, name: "Too late" })).rejects.toThrow();
});

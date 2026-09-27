import { afterAll, beforeAll, expect, it } from "vitest";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { createWorkflow, resolveAccountIdentity, requestWorkflowDeletion } from "@tabductor/engine";
import { seedWorkflow, staticSchemaGenerator } from "@tabductor/engine/testing";
import { createCaller } from "../../apps/web/src/server/router.js";

let db: MigratedTestDb, owner: string, other: string;
const caller = (accountId: string) => createCaller({ db: db.db, pool: db.pool, accountId, schemaGenerator: staticSchemaGenerator({}) });
beforeAll(async () => {
  db = await createMigratedTestDb();
  owner = await resolveAccountIdentity(db.db, { provider: "fixture", subject: "rename-owner" });
  other = await resolveAccountIdentity(db.db, { provider: "fixture", subject: "rename-other" });
});
afterAll(async () => { await db?.close(); });

it("renames a published workflow without changing its prompt or version", async () => {
  const workflowId = await createWorkflow(db.db, { accountId: owner, userId: "fixture", name: "Original" });
  await caller(owner).workflow.savePrompt({ workflowId, expectedVersionId: null, definition: { prompt: "Browse" } });
  const before = await caller(owner).workflow.get({ id: workflowId });
  expect(await caller(owner).workflow.rename({ workflowId, name: "  New workflow name  " })).toEqual({ name: "New workflow name" });
  const after = await caller(owner).workflow.get({ id: workflowId });
  expect(after.workflow.name).toBe("New workflow name");
  expect(after.versionId).toBe(before.versionId);
  expect(after.definition).toEqual(before.definition);
  await expect(caller(other).workflow.rename({ workflowId, name: "Foreign" })).rejects.toThrow();
  for (const name of ["", "   ", "x".repeat(201)]) {
    await expect(caller(owner).workflow.rename({ workflowId, name })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
  expect((await caller(owner).workflow.get({ id: workflowId })).workflow.name).toBe("New workflow name");
  await requestWorkflowDeletion(db.db, owner, workflowId);
  await expect(caller(owner).workflow.rename({ workflowId, name: "Too late" })).rejects.toThrow();
});

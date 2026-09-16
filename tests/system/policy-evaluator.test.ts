import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newId } from "@tabductor/core";
import {
  accountBaselineRules,
  approvals,
  events,
  runs,
  secretGrants,
  taskGrants,
  tasks,
  workflowVersions,
  workflows,
} from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import {
  DatabasePolicyGate,
  addBaselineRule,
  decideApproval,
  grantTask,
} from "@tabductor/policy";
import { eq } from "drizzle-orm";

let handle: MigratedTestDb;
let taskId: string;
let versionId: string;
let userId: string;

beforeAll(async () => {
  handle = await createMigratedTestDb();
});

afterAll(async () => {
  await handle?.close();
});

beforeEach(async () => {
  const workflowId = newId("wf");
  userId = newId("user");
  versionId = newId("wfv");
  taskId = newId("task");
  await handle.db.insert(workflows).values({ id: workflowId, accountId: "acct_local", userId, name: "Policy test" });
  await handle.db.insert(workflowVersions).values({ id: versionId, workflowId });
  await handle.db.insert(tasks).values({
    id: taskId,
    workflowVersionId: versionId,
    name: "Worker",
    kind: "browser",
    mode: "ai",
  });
});

describe("DatabasePolicyGate", () => {
  it("allows navigation dependencies by default without emitting policy.denied", async () => {
    const gate = new DatabasePolicyGate({ db: handle.db });
    const ctx = { taskId, runId: newId("run") };
    for (const cause of ["initial", "redirect", "window_open", "script"] as const) {
      for (const host of ["app.notion.com", "identity.notion.com", "aif.notion.so", "x.com"]) {
        await expect(gate.checkNavigation(ctx, new URL(`https://${host}/`), cause))
          .resolves.toEqual({ allow: true });
      }
    }
    expect(await handle.db.select().from(events).where(eq(events.sourceRunId, ctx.runId))).toEqual([]);
    await addBaselineRule(handle.db, userId, {
      effect: "deny", grantKey: "navigation", value: "blocked.example",
    });
    await expect(gate.checkNavigation(ctx, new URL("https://blocked.example/"), "redirect"))
      .resolves.toEqual({ allow: false, rule: "baseline_deny:navigation:blocked.example" });
  });

  it("still requires navigation approval in permissive mode when the baseline requests it", async () => {
    const runId = newId("run");
    await handle.db.insert(runs).values({
      id: runId, taskId, workflowVersionId: versionId, modeUsed: "ai", status: "running",
    });
    await addBaselineRule(handle.db, userId, {
      effect: "require_approval", grantKey: "navigation", value: "example.com",
    });
    const gate = new DatabasePolicyGate({ db: handle.db, approvalPollMs: 2, approvalTtlMs: 10 });
    await expect(gate.checkNavigation({ taskId, runId }, new URL("https://example.com/"), "initial"))
      .resolves.toEqual({ allow: false, rule: "approval_expired" });
    expect((await handle.db.select().from(approvals).where(eq(approvals.runId, runId)))[0]?.status)
      .toBe("expired");
  });

  it("uses explicit navigation grants and lets the account baseline override them", async () => {
    const gate = new DatabasePolicyGate({ db: handle.db, navigationMode: "grant_required" });
    const ctx = { taskId, runId: newId("run") };

    await expect(gate.checkNavigation(ctx, new URL("https://example.com/a"), "initial")).resolves.toEqual({
      allow: false,
      rule: "grant_missing:navigation",
    });

    await grantTask(handle.db, taskId, { grantKey: "navigation", grantValue: "example.com" });
    await expect(gate.checkNavigation(ctx, new URL("https://api.example.com/a"), "redirect")).resolves.toEqual({
      allow: true,
    });
    await expect(gate.checkNavigation(ctx, new URL("https://notexample.com/a"), "redirect")).resolves.toEqual({
      allow: false,
      rule: "grant_missing:navigation",
    });

    await addBaselineRule(handle.db, userId, {
      effect: "deny",
      grantKey: "navigation",
      value: "example.com",
    });
    await expect(gate.checkNavigation(ctx, new URL("https://example.com/a"), "initial")).resolves.toEqual({
      allow: false,
      rule: "baseline_deny:navigation:example.com",
    });
  });

  it("enforces the dedicated secret grant table", async () => {
    const gate = new DatabasePolicyGate({ db: handle.db });
    const ctx = { taskId, runId: newId("run") };
    await expect(gate.checkSecretUse(ctx, "login")).resolves.toEqual({
      allow: false,
      rule: "grant_missing:secret.use",
    });
    await handle.db.insert(secretGrants).values({ taskId, secretName: "login" });
    await expect(gate.checkSecretUse(ctx, "login")).resolves.toEqual({ allow: true });
  });

  it("masks credentials even with header access until secrets.read is separately granted", async () => {
    const gate = new DatabasePolicyGate({ db: handle.db });
    const ctx = { taskId, runId: newId("run") };
    await grantTask(handle.db, taskId, { grantKey: "network.headers", grantValue: "*" });

    await expect(
      gate.checkNetworkRead(ctx, { index: 1, url: "https://example.com" }, { headers: true }),
    ).resolves.toEqual({ allow: true });
    await expect(
      gate.redact(ctx, {
        headers: { Authorization: "Bearer top-secret", "Content-Type": "application/json" },
        body: "access_token=also-secret",
      }),
    ).resolves.toEqual({
      headers: { Authorization: "[REDACTED]", "Content-Type": "application/json" },
      body: "[REDACTED]",
    });

    await grantTask(handle.db, taskId, { grantKey: "secrets.read", grantValue: "*" });
    const raw = { headers: { Authorization: "Bearer top-secret" }, body: "access_token=also-secret" };
    await expect(gate.redact(ctx, raw)).resolves.toBe(raw);
  });

  it("parks at the interception point and resumes only after the persisted approval", async () => {
    const runId = newId("run");
    await handle.db.insert(runs).values({
      id: runId,
      taskId,
      workflowVersionId: versionId,
      modeUsed: "ai",
      status: "running",
    });
    await grantTask(handle.db, taskId, {
      grantKey: "action",
      grantValue: "page.click",
      requiresApproval: true,
    });
    const gate = new DatabasePolicyGate({ db: handle.db, approvalPollMs: 5, approvalTtlMs: 2_000 });

    const verdict = gate.checkAction({ taskId, runId }, { kind: "page.click", selector: "#purchase" });
    let pending = (await handle.db.select().from(approvals).where(eq(approvals.runId, runId)))[0];
    for (let i = 0; !pending && i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      pending = (await handle.db.select().from(approvals).where(eq(approvals.runId, runId)))[0];
    }
    expect(pending?.status).toBe("pending");
    expect((await handle.db.select().from(runs).where(eq(runs.id, runId)))[0]?.status).toBe("awaiting_approval");

    expect((await decideApproval(handle.db, pending!.id, "granted")).outcome).toBe("decided");
    await expect(verdict).resolves.toEqual({ allow: true });
    expect((await handle.db.select().from(runs).where(eq(runs.id, runId)))[0]?.status).toBe("running");

    const systemEvents = await handle.db.select().from(events).where(eq(events.sourceRunId, runId));
    expect(systemEvents.map((event) => event.type).sort()).toEqual(["approval.granted", "approval.requested"]);
  });

  it("expires a parked action and restores the run so the executor can fail it", async () => {
    const runId = newId("run");
    await handle.db.insert(runs).values({
      id: runId,
      taskId,
      workflowVersionId: versionId,
      modeUsed: "ai",
      status: "running",
    });
    await grantTask(handle.db, taskId, {
      grantKey: "action",
      grantValue: "page.click",
      requiresApproval: true,
    });
    const gate = new DatabasePolicyGate({ db: handle.db, approvalPollMs: 2, approvalTtlMs: 10 });

    await expect(gate.checkAction({ taskId, runId }, { kind: "page.click" })).resolves.toEqual({
      allow: false,
      rule: "approval_expired",
    });
    expect((await handle.db.select().from(runs).where(eq(runs.id, runId)))[0]?.status).toBe("running");
    expect((await handle.db.select().from(approvals).where(eq(approvals.runId, runId)))[0]?.status).toBe("expired");
  });

  it("fails closed on a malformed baseline rule", async () => {
    await handle.db.insert(taskGrants).values({ taskId, grantKey: "navigation", grantValue: "example.com" });
    await handle.db.insert(accountBaselineRules).values({
      id: newId("baseline"),
      userId,
      // Deliberately bypass the typed admin API: corrupted/operator-authored DB state must deny.
      ruleJson: { effect: "allow_everything" },
    });
    const gate = new DatabasePolicyGate({ db: handle.db });
    await expect(
      gate.checkNavigation({ taskId, runId: newId("run") }, new URL("https://example.com"), "initial"),
    ).resolves.toEqual({ allow: false, rule: "baseline_invalid" });
  });
});

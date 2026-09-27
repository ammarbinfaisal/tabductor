import { afterEach, beforeEach, expect, it } from "vitest";
import { browserProfiles, tasks, workflowBrowserProfiles, workflows, workflowVersions } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { createBrowserProfile, ensureWorkflowBrowserProfile, resolveAccountIdentity } from "@tabductor/engine";
import { createCaller } from "../../apps/web/src/server/router.js";

let handle: MigratedTestDb;
beforeEach(async () => { handle = await createMigratedTestDb(); });
afterEach(async () => { await handle?.close(); });

it("creates a workflow bound to the selected existing profile for its first browser session", async () => {
  const api = createCaller({ db: handle.db });
  await api.browserSession.createProfile({ name: "Personal" });
  const { profileId } = await api.browserSession.createProfile({ name: "Work" });
  const created = await api.workflow.createFromPrompt({ prompt: "Read my work dashboard", profileId });

  expect(await api.browserSession.workflowProfile({ workflowId: created.workflowId })).toEqual({ profileId });
  expect(await ensureWorkflowBrowserProfile(handle.db, "acct_local", created.workflowId)).toBe(profileId);
  expect(await handle.db.select().from(browserProfiles)).toHaveLength(2);
  expect((await api.workflow.get({ id: created.workflowId })).definition?.prompt).toBe("Read my work dashboard");
});

it.each(["missing", "foreign"])("rejects a %s profile without leaving a partial workflow", async kind => {
  const api = createCaller({ db: handle.db });
  let profileId = "profile_missing";
  if (kind === "foreign") {
    const accountId = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "other" });
    profileId = await createBrowserProfile(handle.db, { accountId, name: "Other account" });
    expect(await api.browserSession.profiles()).toEqual([]);
  }

  await expect(api.workflow.createFromPrompt({ prompt: "Read my dashboard", profileId }))
    .rejects.toMatchObject({ cause: { code: "browser_profile_not_found" } });
  expect(await handle.db.select().from(workflows)).toEqual([]);
  expect(await handle.db.select().from(workflowVersions)).toEqual([]);
  expect(await handle.db.select().from(tasks)).toEqual([]);
  expect(await handle.db.select().from(workflowBrowserProfiles)).toEqual([]);
});

it("preserves profile-free creation for existing API clients", async () => {
  const api = createCaller({ db: handle.db });
  const created = await api.workflow.createFromPrompt({ prompt: "Read a public page" });
  expect(await api.browserSession.workflowProfile({ workflowId: created.workflowId })).toBeNull();
});

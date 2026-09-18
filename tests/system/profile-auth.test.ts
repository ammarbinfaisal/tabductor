import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { browserProfiles, browserProfileImports } from "@tabductor/db";
import { fileKeyWrapper, withEnvelope } from "@tabductor/secrets";
import { createBrowserProfile, createProfileImport, importProfileAuth, resolveAccountIdentity, requestBrowserSession, claimBrowserAllocation, bindWorkflowProfile, createWorkflow } from "@tabductor/engine";
import { eq, sql } from "drizzle-orm";
let handle: MigratedTestDb; let dir: string;
beforeEach(async () => { handle = await createMigratedTestDb(); dir = await mkdtemp(join(tmpdir(), "profile-auth-")); });
afterEach(async () => { await handle?.close(); if (dir) await rm(dir, { recursive: true, force: true }); });
const state = { origin: "https://example.com", cookies: [{ name: "login", value: "private-cookie", domain: ".example.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }], localStorage: [{ name: "auth", value: "private-storage" }] };
async function setup() {
  const accountId = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "owner" });
  const profileId = await createBrowserProfile(handle.db, { accountId, name: "Work" });
  return { accountId, profileId, wrapper: fileKeyWrapper(join(dir, "kek.json")) };
}
it("encrypts full origin state and consumes a single-use, origin-bound grant", async () => {
  const { accountId, profileId, wrapper } = await setup();
  const grant = await createProfileImport(handle.db, { accountId, profileId, origin: state.origin });
  await expect(importProfileAuth(handle.db, wrapper, grant.token, { ...state, origin: "https://other.example.com" })).rejects.toMatchObject({ code: "profile_import_invalid" });
  await expect(importProfileAuth(handle.db, wrapper, grant.token, state)).resolves.toMatchObject({ imported: true, cookies: 1, localStorageEntries: 1 });
  const [profile] = await handle.db.select().from(browserProfiles).where(eq(browserProfiles.id, profileId));
  const [storedGrant] = await handle.db.select().from(browserProfileImports);
  expect(JSON.stringify(profile)).not.toContain("private-cookie");
  expect(JSON.stringify(profile)).not.toContain("private-storage");
  expect(JSON.stringify(storedGrant)).not.toContain(grant.token);
  await withEnvelope(wrapper, profile!.pendingAuthEnvelope!, async bytes => { expect(JSON.parse(bytes.toString())).toEqual([state]); });
  await expect(importProfileAuth(handle.db, wrapper, grant.token, state)).rejects.toMatchObject({ code: "profile_import_invalid" });
});
it("rejects foreign profiles, expired grants, foreign cookies and active profile imports", async () => {
  const { accountId, profileId, wrapper } = await setup();
  const foreign = await resolveAccountIdentity(handle.db, { provider: "fixture", subject: "other" });
  await expect(createProfileImport(handle.db, { accountId: foreign, profileId, origin: state.origin })).rejects.toMatchObject({ code: "browser_profile_not_found" });
  const workflowId = await createWorkflow(handle.db, { accountId: foreign, userId: "other", name: "Other" });
  await expect(bindWorkflowProfile(handle.db, { accountId: foreign, workflowId, profileId })).rejects.toMatchObject({ code: "browser_profile_not_found" });
  const grant = await createProfileImport(handle.db, { accountId, profileId, origin: state.origin });
  await expect(importProfileAuth(handle.db, wrapper, grant.token, { ...state, cookies: [{ ...state.cookies[0], domain: "another.com" }] })).rejects.toMatchObject({ code: "profile_auth_invalid" });
  await requestBrowserSession(handle.db, { accountId, profileId }); await claimBrowserAllocation(handle.db);
  await expect(importProfileAuth(handle.db, wrapper, grant.token, state)).rejects.toMatchObject({ code: "profile_in_use" });
  await handle.db.update(browserProfileImports).set({ expiresAt: sql`now() - interval '1 second'` });
  await expect(importProfileAuth(handle.db, wrapper, grant.token, state)).rejects.toMatchObject({ code: "profile_import_invalid" });
});
it("replaces an origin's complete state while retaining other imported origins", async () => {
  const { accountId, profileId, wrapper } = await setup();
  for (const value of [state, { ...state, origin: "https://second.example.com", cookies: [] }, { ...state, cookies: [], localStorage: [] }]) {
    const grant = await createProfileImport(handle.db, { accountId, profileId, origin: value.origin });
    await importProfileAuth(handle.db, wrapper, grant.token, value);
  }
  const [profile] = await handle.db.select().from(browserProfiles).where(eq(browserProfiles.id, profileId));
  await withEnvelope(wrapper, profile!.pendingAuthEnvelope!, async bytes => {
    const states = JSON.parse(bytes.toString());
    expect(states).toHaveLength(2);
    expect(states.find((entry: typeof state) => entry.origin === state.origin)).toEqual({ ...state, cookies: [], localStorage: [] });
    expect(states.find((entry: typeof state) => entry.origin === "https://second.example.com").localStorage).toEqual(state.localStorage);
  });
});

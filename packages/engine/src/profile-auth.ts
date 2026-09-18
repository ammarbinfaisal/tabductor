import { createHash, randomBytes } from "node:crypto";
import { AppError } from "@tabductor/core";
import { browserProfiles, browserProfileImports, browserProfileLeases, workflowBrowserProfiles, workflows, type Db } from "@tabductor/db";
import { encryptEnvelope, withEnvelope, type KeyWrapper } from "@tabductor/secrets";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

export const profileOriginSchema = z.string().url().max(2048).transform(value => {
  const url = new URL(value);
  if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) throw new AppError("profile_origin_invalid", "Use an HTTP or HTTPS website address");
  return url.origin;
});
const cookieSchema = z.object({ name: z.string().max(4096), value: z.string().max(16384), domain: z.string().min(1).max(253),
  path: z.string().startsWith("/").max(2048), expires: z.number().finite().min(-1), httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.enum(["Strict", "Lax", "None"]) }).strict();
export const profileAuthSchema = z.object({ origin: profileOriginSchema, cookies: z.array(cookieSchema).max(1000),
  localStorage: z.array(z.object({ name: z.string().max(65536), value: z.string().max(6 * 1024 * 1024) }).strict()).max(10000) }).strict().superRefine((state, ctx) => {
  const host = new URL(state.origin).hostname;
  if (state.cookies.some(cookie => {
    const domain = cookie.domain.replace(/^\./, "");
    return !domain || !(host === domain || (domain.includes(".") && host.endsWith(`.${domain}`)));
  })) ctx.addIssue({ code: "custom", message: "Cookies must belong to the selected website" });
  if (new Set(state.localStorage.map(entry => entry.name)).size !== state.localStorage.length)
    ctx.addIssue({ code: "custom", message: "Duplicate local storage keys" });
});
export type ProfileAuthState = z.infer<typeof profileAuthSchema>;
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const admissionLock = (db: Db) => db.execute(sql`select pg_advisory_xact_lock(hashtextextended('browser-fleet-admission', 0))`);

export async function createProfileImport(db: Db, input: { accountId: string; profileId: string; origin: string }) {
  const origin = profileOriginSchema.parse(input.origin);
  const [profile] = await db.select({ name: browserProfiles.name }).from(browserProfiles).where(and(eq(browserProfiles.id, input.profileId), eq(browserProfiles.accountId, input.accountId)));
  if (!profile) throw new AppError("browser_profile_not_found", "Browser profile not found");
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 5 * 60_000);
  await db.insert(browserProfileImports).values({ tokenHash: digest(token), accountId: input.accountId, profileId: input.profileId, origin, expiresAt });
  return { token, origin, profileName: profile.name, expiresAt };
}

export async function importProfileAuth(db: Db, wrapper: KeyWrapper, token: string, value: unknown) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError("profile_import_invalid", "Import code is invalid or expired");
  const parsed = profileAuthSchema.safeParse(value);
  if (!parsed.success) throw new AppError("profile_auth_invalid", "Invalid website authentication data");
  const state = parsed.data;
  return db.transaction(async trx => {
    await admissionLock(trx);
    const [grant] = await trx.select().from(browserProfileImports).where(eq(browserProfileImports.tokenHash, digest(token))).for("update");
    if (!grant || grant.usedAt || grant.expiresAt.getTime() <= Date.now() || grant.origin !== state.origin) throw new AppError("profile_import_invalid", "Import code is invalid, expired, used, or for another website");
    const [profile] = await trx.select().from(browserProfiles).where(and(eq(browserProfiles.id, grant.profileId), eq(browserProfiles.accountId, grant.accountId))).for("update");
    if (!profile) throw new AppError("browser_profile_not_found", "Browser profile not found");
    const [lease] = await trx.select().from(browserProfileLeases).where(eq(browserProfileLeases.profileId, profile.id));
    if (lease) throw new AppError("profile_in_use", "Stop the profile session before importing authentication");
    const prior: ProfileAuthState[] = profile.pendingAuthEnvelope
      ? await withEnvelope(wrapper, profile.pendingAuthEnvelope, async bytes => z.array(profileAuthSchema).parse(JSON.parse(bytes.toString()))) : [];
    const merged = [...prior.filter(entry => entry.origin !== state.origin), state];
    const plaintext = Buffer.from(JSON.stringify(merged));
    try {
      if (plaintext.length > 16 * 1024 * 1024) throw new AppError("profile_auth_too_large", "Pending profile authentication exceeds 16 MiB; open and save the profile before importing more sites");
      const pendingAuthEnvelope = await encryptEnvelope(wrapper, plaintext);
      await trx.update(browserProfiles).set({ pendingAuthEnvelope, updatedAt: sql`now()` }).where(eq(browserProfiles.id, profile.id));
      await trx.update(browserProfileImports).set({ usedAt: sql`now()` }).where(eq(browserProfileImports.tokenHash, grant.tokenHash));
      return { imported: true, cookies: state.cookies.length, localStorageEntries: state.localStorage.length };
    } finally { plaintext.fill(0); }
  });
}

export async function bindWorkflowProfile(db: Db, input: { accountId: string; workflowId: string; profileId: string }) {
  return db.transaction(async trx => {
    const [workflow] = await trx.select({ id: workflows.id }).from(workflows).where(and(eq(workflows.id, input.workflowId), eq(workflows.accountId, input.accountId))).for("update");
    const [profile] = await trx.select({ id: browserProfiles.id }).from(browserProfiles).where(and(eq(browserProfiles.id, input.profileId), eq(browserProfiles.accountId, input.accountId)));
    if (!workflow || !profile) throw new AppError("browser_profile_not_found", "Workflow or browser profile not found");
    await trx.insert(workflowBrowserProfiles).values({ workflowId: input.workflowId, profileId: input.profileId })
      .onConflictDoUpdate({ target: workflowBrowserProfiles.workflowId, set: { profileId: input.profileId } });
    return { profileId: input.profileId };
  });
}

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { AppError, newId } from "@tabductor/core";
import { eventDefs, tasks, workflows, workflowShares, type Db, type WorkflowShareRow } from "@tabductor/db";
import { and, eq, isNull } from "drizzle-orm";

/**
 * Shares (S2d, `docs/sharing.md`): an unguessable link granting read-only access to one
 * workflow's execution.
 *
 * The token is a bearer credential in a URL — the same class of object as a CDP `wss://`
 * endpoint (§16 Threat 5) — so only its SHA-256 is stored. A dump of `workflow_shares`
 * yields no working links, and a lost link is replaced by rotating rather than recovered.
 * Nothing here ever logs a token or returns one from a read.
 */

const TOKEN_BYTES = 32;
const PREFIX_LENGTH = 8;

export const SHARE_NOT_FOUND = "share_not_found";

export type ShareSummary = {
  id: string;
  tokenPrefix: string;
  createdAt: Date;
  revokedAt: Date | null;
};

/** The one shape that carries a plaintext token, returned by create/rotate and never stored. */
export type IssuedShare = ShareSummary & { token: string };

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function issue(): { token: string; tokenSha256: string; tokenPrefix: string } {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, tokenSha256: hashToken(token), tokenPrefix: token.slice(0, PREFIX_LENGTH) };
}

const notFound = (shareId: string): AppError =>
  new AppError(SHARE_NOT_FOUND, `no live share "${shareId}"`, { details: { shareId } });

export async function createShare(db: Db, input: { workflowId: string }): Promise<IssuedShare> {
  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, input.workflowId));
  if (!workflow) {
    throw new AppError("workflow_not_found", `no workflow "${input.workflowId}"`, {
      details: { workflowId: input.workflowId },
    });
  }

  const { token, tokenSha256, tokenPrefix } = issue();
  const [row] = await db
    .insert(workflowShares)
    .values({ id: newId("share"), workflowId: workflow.id, tokenSha256, tokenPrefix })
    .returning();
  return { id: row!.id, token, tokenPrefix, createdAt: row!.createdAt, revokedAt: null };
}

/**
 * A new token for the same share, keeping its identity and its visibility manifest.
 *
 * A revoked share cannot be rotated: rotation would resurrect a link the owner deliberately
 * killed, which is the opposite of what the word promises.
 */
export async function rotateShare(db: Db, input: { shareId: string }): Promise<IssuedShare> {
  const { token, tokenSha256, tokenPrefix } = issue();
  const [row] = await db
    .update(workflowShares)
    .set({ tokenSha256, tokenPrefix })
    .where(and(eq(workflowShares.id, input.shareId), isNull(workflowShares.revokedAt)))
    .returning();
  if (!row) throw notFound(input.shareId);
  return { id: row.id, token, tokenPrefix, createdAt: row.createdAt, revokedAt: null };
}

export async function revokeShare(db: Db, input: { shareId: string }): Promise<void> {
  const rows = await db
    .update(workflowShares)
    .set({ revokedAt: new Date() })
    .where(and(eq(workflowShares.id, input.shareId), isNull(workflowShares.revokedAt)))
    .returning({ id: workflowShares.id });
  if (rows.length === 0) throw notFound(input.shareId);
}

export async function listShares(db: Db, input: { workflowId: string }): Promise<ShareSummary[]> {
  return db
    .select({
      id: workflowShares.id,
      tokenPrefix: workflowShares.tokenPrefix,
      createdAt: workflowShares.createdAt,
      revokedAt: workflowShares.revokedAt,
    })
    .from(workflowShares)
    .where(eq(workflowShares.workflowId, input.workflowId))
    .orderBy(workflowShares.createdAt);
}

/**
 * Token → the share row, revoked or not. One indexed lookup on every public request,
 * deliberately uncached: revocation has to take effect on the next request, and an index
 * probe is cheaper than a cache that can be wrong.
 *
 * Revoked rows come back rather than being filtered here so the caller can *count* revoked
 * and unknown separately — "someone is using an old link" and "someone is guessing tokens"
 * are different operational signals. The caller must still answer both identically: a
 * distinct "revoked" response would confirm a workflow existed. That split — same answer,
 * different metric — is why this is one query and not two.
 */
export async function findShareByToken(db: Db, token: string): Promise<WorkflowShareRow | undefined> {
  if (!token) return undefined;
  const [row] = await db
    .select()
    .from(workflowShares)
    .where(eq(workflowShares.tokenSha256, hashToken(token)));
  return row;
}

/** The live-share half of `findShareByToken`, for callers with no metric to record. */
export async function resolveShare(db: Db, token: string): Promise<WorkflowShareRow | undefined> {
  const row = await findShareByToken(db, token);
  return row && row.revokedAt === null ? row : undefined;
}

/**
 * The visibility manifest, as the set of event types a viewer of this workflow may read
 * packets for.
 *
 * Read from the **current** version, not from the version an event was emitted under. The
 * manifest versions with the graph (that is what makes a new node arrive private), but
 * *enforcement* follows the latest consent: unticking an event type hides its history too,
 * which is what unticking a box is understood to mean. Deny wins.
 */
export async function publicEventTypes(db: Db, workflowId: string): Promise<Set<string>> {
  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, workflowId));
  if (!workflow?.currentVersionId) return new Set();

  const rows = await db
    .select({ eventType: eventDefs.eventType })
    .from(eventDefs)
    .innerJoin(tasks, eq(tasks.id, eventDefs.taskId))
    .where(and(eq(tasks.workflowVersionId, workflow.currentVersionId), eq(eventDefs.public, true)));
  return new Set(rows.map((r) => r.eventType));
}

/**
 * Share-scoped opaque ids.
 *
 * A public page has to address a specific run or event, and handing out the real row id
 * would be a live hole today: there is no auth, so `run.get` and `event.get` accept a bare
 * id from anyone. A viewer who learned a real run id could read the owner's full run row —
 * error text included — through the owner's own procedures.
 *
 * So refs are AES-256-GCM ciphertexts of the row id under a key derived from the share's
 * token hash. They decode only under the share that issued them, they are authenticated
 * (a tampered ref fails the tag rather than addressing a neighbouring row), and they are
 * deterministic — the IV is derived from the id, so the same row keeps the same ref across
 * renders and a link stays valid.
 *
 * This is not a substitute for authorization. It is what keeps a read-only capability from
 * becoming a handle on the authenticated API before that API has any authorization at all.
 */
const REF_INFO = "tabductor/share-ref/v1";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export type RefCodec = { encode: (id: string) => string; decode: (ref: string) => string | null };

export function refCodec(share: Pick<WorkflowShareRow, "tokenSha256">): RefCodec {
  const key = createHash("sha256").update(`${share.tokenSha256}|${REF_INFO}`).digest();

  return {
    encode(id) {
      const iv = createHmac("sha256", key).update(id).digest().subarray(0, IV_LENGTH);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(id, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
    },

    decode(ref) {
      try {
        const raw = Buffer.from(ref, "base64url");
        if (raw.length <= IV_LENGTH + TAG_LENGTH) return null;
        const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_LENGTH));
        decipher.setAuthTag(raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
        const id = Buffer.concat([
          decipher.update(raw.subarray(IV_LENGTH + TAG_LENGTH)),
          decipher.final(),
        ]).toString("utf8");
        return id || null;
      } catch {
        // A wrong share's ref, a truncated one, or a hand-edited one. All the same answer.
        return null;
      }
    },
  };
}

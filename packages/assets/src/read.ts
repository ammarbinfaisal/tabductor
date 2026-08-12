import type { BlobStore } from "@tabductor/browser/blob-store";
import { assets, type Db } from "@tabductor/db";
import { and, eq } from "drizzle-orm";

/**
 * The non-tool-shaped read path S5f needed and S5a–S5e never built: every existing reader in
 * this package is either LLM-facing (`tools.ts`'s `assets.read`, text-only, truncated,
 * wrapped as untrusted) or private-and-path-keyed (`tools.ts`'s `currentAsset`,
 * `render.ts`'s `readCurrentAssetBytes`). `page.upload(anchor, assetRef)` (techical_plan
 * §13.5) needs neither of those: it has an **asset ref** — `{asset_id, path, mime, sha256}`,
 * the shape a packet carries (`@tabductor/core`'s `ASSET_REF_SCHEMA`) — sitting in a *browser*
 * task's trigger packet, and needs the raw bytes back, untruncated, to hand to a file input.
 * Keying the lookup on `asset_id` rather than `path` matches what the caller actually holds
 * (a packet field, not a path the browser task's own prompt authored) and doubles as a cheap
 * ownership check: `and(userId, id)` is the same `(user_id, path)` scoping every other reader
 * in this package uses, just against the other half of that unique surface.
 *
 * Exported from this package (not duplicated in `@tabductor/agent`) for the same reason
 * `putVersion` is: one asset-store read/write path, reused by every caller outside the LLM
 * tool boundary rather than re-derived per consumer.
 */
export type ResolvedAsset = {
  assetId: string;
  path: string;
  mime: string;
  sha256: string;
  bytes: Buffer;
};

export type ReadAssetDeps = { db: Db; blobs: BlobStore };

/** `undefined` for "no such asset in this user's namespace" — the caller's to turn into a
 * tool error, exactly like every other not-found case in this package. */
export async function readAssetById(
  deps: ReadAssetDeps,
  userId: string,
  assetId: string,
): Promise<ResolvedAsset | undefined> {
  const [row] = await deps.db
    .select({ id: assets.id, path: assets.path, mime: assets.mime, sha256: assets.sha256, blobRef: assets.blobRef })
    .from(assets)
    .where(and(eq(assets.userId, userId), eq(assets.id, assetId)));
  if (!row) return undefined;
  const bytes = await deps.blobs.get(row.blobRef);
  return { assetId: row.id, path: row.path, mime: row.mime, sha256: row.sha256, bytes };
}

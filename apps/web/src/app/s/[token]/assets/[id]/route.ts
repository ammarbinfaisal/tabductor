import { AppError } from "@tabductor/core";
import { findShareByToken, publicAssetRef, publicEventTypes } from "@tabductor/engine";
import { blobStore } from "../../../../../server/blob-store.js";
import { db } from "../../../../../server/db.js";
import { metricsNow } from "../../../../../server/metrics.js";
import { createRateLimiter } from "../../../../../server/rate-limit.js";

/**
 * `/s/<token>/assets/<id>` (sharing.md §4.4, §5.1–5.3) — the public sibling of the owner's
 * screenshot route (`api/blobs/[ref]/route.ts`): same two-check shape (row lookup, then
 * store fetch), stricter posture throughout, because this one has no session and no account
 * behind it at all.
 *
 * Three differences from the owner route, each because this is `/s/*`, not an authenticated
 * surface:
 * 1. The "row lookup" is `publicAssetRef` — a *gate*, not a `select` — so an asset nobody
 *    may see is never read (`ROADMAP.md`'s binding "no public read path that fetches first
 *    and redacts afterward" rule, applied to blobs rather than packets).
 * 2. Rate-limited, per client and per share, checked **before** `publicAssetRef` runs — same
 *    ordering `shareProcedure` (`trpc.ts`) uses and the same reason: guessing asset ids
 *    should cost the guesser before it costs Postgres a `jsonb_path_exists` scan.
 * 3. `Content-Disposition: attachment` always (no inline-image carve-out), a MIME allowlist
 *    rather than whatever `assets.mime` says, `nosniff`, `CSP: sandbox`, `X-Robots-Tag` and
 *    `Referrer-Policy` — sharing.md §5.2's whole header table, since a Route Handler sits
 *    outside `ShareLayout`'s React tree and must set its own.
 *
 * `db()`/`blobStore()`/`metricsNow()` are the same globalThis-memoized composition-root
 * singletons the owner route uses (`server/db.ts`, `server/blob-store.ts`) — this file reads
 * them, it does not own them.
 *
 * Returns the standard Web `Response`, not `NextResponse` — nothing here needs `next/server`
 * (no cookies, no redirect helper), and a Route Handler is documented to accept either. That
 * also keeps this route resolvable under the root workspace's Node-style module resolution:
 * `next/server`'s types are shaped for `apps/web`'s own bundler resolution and are not
 * resolvable from a system test importing this file under the root `tsconfig.json`.
 */

// Same capacities `trpc.ts`'s `shareProcedure` uses for its own two buckets — a second pair
// of instances, not the same objects, because this is a different route with its own load
// shape, not a shared budget with the tRPC public router.
const clientLimiter = createRateLimiter({ capacity: 120, refillPerSecond: 4 });
const shareLimiter = createRateLimiter({ capacity: 240, refillPerSecond: 8 });

/** sharing.md §5.2: "a narrow allowlist derived from what the asset store can produce."
 * Anything else is served as `application/octet-stream` rather than trusted verbatim. */
const ASSET_MIME_ALLOWLIST: ReadonlySet<string> = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "text/markdown",
  "text/plain",
  "text/html",
  "image/png",
  "image/jpeg",
  "application/json",
]);

const PUBLIC_HEADERS: Record<string, string> = {
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "Content-Disposition": "attachment",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox",
};

/** Same speed-bump reasoning as `trpc.ts`'s `clientKeyOf` — not authorization, just a
 * per-caller bucket key for callers who set nothing trustworthy. */
function clientKeyOf(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}

/** Unknown share, revoked share, unknown asset, and an asset no public packet references
 * are **all** this — indistinguishable, same as every other public route (sharing.md §5.1). */
function gone(): Response {
  return new Response(null, { status: 404, headers: PUBLIC_HEADERS });
}

function rateLimited(): Response {
  return new Response(null, { status: 429, headers: PUBLIC_HEADERS });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string; id: string }> },
): Promise<Response> {
  const { token, id } = await params;
  const metrics = metricsNow();

  if (!clientLimiter.take(clientKeyOf(req))) {
    metrics?.shareAssetReads.add("denied");
    return rateLimited();
  }

  const share = await findShareByToken(db(), token);
  if (!share || share.revokedAt !== null) {
    metrics?.shareAssetReads.add("not_found");
    return gone();
  }

  if (!shareLimiter.take(share.id)) {
    metrics?.shareAssetReads.add("denied");
    return rateLimited();
  }

  const publicTypes = await publicEventTypes(db(), share.workflowId);
  const asset = await publicAssetRef(db(), { workflowId: share.workflowId, publicTypes, assetId: id });
  if (!asset) {
    metrics?.shareAssetReads.add("not_found");
    return gone();
  }

  let bytes: Buffer;
  try {
    bytes = await blobStore().get(asset.blobRef);
  } catch (err) {
    // A row pointing at a ref the store no longer has is a data problem, not a caller one,
    // but the public posture answers it the same as every other unresolved id: 404.
    if (err instanceof AppError && err.code === "blob_ref_invalid") {
      metrics?.shareAssetReads.add("not_found");
      return gone();
    }
    throw err;
  }

  const mime = ASSET_MIME_ALLOWLIST.has(asset.mime) ? asset.mime : "application/octet-stream";
  metrics?.shareAssetReads.add("ok");
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      ...PUBLIC_HEADERS,
      "Content-Type": mime,
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}

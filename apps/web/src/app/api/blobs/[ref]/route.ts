import { AppError } from "@tabductor/core";
import { artifacts } from "@tabductor/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { blobStore } from "../../../../server/blob-store.js";
import { db } from "../../../../server/db.js";

/**
 * Screenshot serving (U1.5), owner-side. This is not `/s/*` — no share token gates it, so
 * it inherits none of the public-route posture; what it does inherit, on purpose, is the
 * §16 Threat 15 mentality (serving user-supplied blobs), because a screenshot's bytes are a
 * scraped page and nobody has reviewed them.
 *
 * Two checks, in this order, and the order is load-bearing:
 * 1. **`artifacts` lookup first.** The route serves only what a run actually produced — a
 *    ref no artifact row points to is a 404, whether that is because it was never written,
 *    it belongs to a different store entirely, or it is simply malformed. This also means a
 *    malformed ref almost never reaches `blobStore().get()` at all, since it cannot match a
 *    row that was written by `createMinioBlobStore.put()`.
 * 2. **The store's own `blob_ref_invalid`**, mapped to 400. Kept as a second check rather
 *    than trusted to (1): a ref could in principle match an `artifacts` row and still fail
 *    the store's own shape check if the two ever drift, and that failure should read as
 *    "bad request," not as the 500 an unmapped throw would produce.
 */

/** §16 Threat 15: everything else is a download, never rendered by the browser. */
const INLINE_MIME = new Set(["image/png", "image/jpeg"]);

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ ref: string }> },
): Promise<Response> {
  const { ref } = await params;
  const decoded = decodeURIComponent(ref);

  const [artifact] = await db()
    .select({ meta: artifacts.meta })
    .from(artifacts)
    .where(eq(artifacts.blobRef, decoded));
  if (!artifact) return new NextResponse(null, { status: 404 });

  const meta = artifact.meta as { mime?: unknown };
  const mime = typeof meta.mime === "string" ? meta.mime : "application/octet-stream";

  let bytes: Buffer;
  try {
    bytes = await blobStore().get(decoded);
  } catch (err) {
    if (err instanceof AppError && err.code === "blob_ref_invalid") {
      return new NextResponse(null, { status: 400 });
    }
    throw err;
  }

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": mime,
      "X-Content-Type-Options": "nosniff",
      // Content-addressed (the ref is the sha256 digest): the bytes at this URL never
      // change, so the strongest cache directive is correct, not just permissive.
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": INLINE_MIME.has(mime) ? "inline" : "attachment",
    },
  });
}

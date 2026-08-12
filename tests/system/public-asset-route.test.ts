import { afterEach, expect, it } from "vitest";
import { publish } from "@tabductor/bus";
import type { BlobStore } from "@tabductor/browser/blob-store";
import { newId } from "@tabductor/core";
import { assets, type Db, type DbHandle } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import {
  createShare,
  publicAssetRef,
  publicEventTypes,
  revokeShare,
  seedWorkflow,
  type IssuedShare,
  type SeededWorkflow,
} from "@tabductor/engine";
import { createTestBlobStore, type TestBlobStore } from "@tabductor/testkit";
import { GET } from "../../apps/web/src/app/s/[token]/assets/[id]/route.js";

/**
 * The public asset route (S5d, sharing.md §4.4, §5.1–5.3).
 *
 * `db()`/`blobStore()` (`apps/web/src/server/{db,blob-store}.ts`) are globalThis-memoized
 * composition-root singletons by design — Next re-evaluates modules on every dev-server
 * save, so they cache themselves there rather than reconnecting each time. That is also the
 * seam a test uses to give the route an isolated database and bucket: seed the same globals
 * directly before each case, clear them after, exactly the shape those two files' own doc
 * comments describe.
 */

type GlobalStore = { __tabductorDb?: DbHandle; __tabductorBlobs?: BlobStore };

let handle: MigratedTestDb | undefined;
let tb: TestBlobStore | undefined;

afterEach(async () => {
  const g = globalThis as GlobalStore;
  delete g.__tabductorDb;
  delete g.__tabductorBlobs;
  await tb?.drop();
  tb = undefined;
  await handle?.close();
  handle = undefined;
});

async function wireComposition(): Promise<{ db: Db; blobs: BlobStore }> {
  handle = await createMigratedTestDb();
  tb = await createTestBlobStore();
  const g = globalThis as GlobalStore;
  g.__tabductorDb = handle;
  g.__tabductorBlobs = tb.store;
  return { db: handle.db, blobs: tb.store };
}

const REPORT_MIME = "application/pdf";

/** One private-type asset node, one asset written and referenced by a `private` packet —
 * the shape both the "absent from the read model" and the "404" tests start from. */
async function seedPrivateAsset(
  db: Db,
  blobs: BlobStore,
): Promise<{ wf: SeededWorkflow; assetId: string }> {
  const wf = await seedWorkflow(db, { tasks: { A: { kind: "asset", mode: "ai", emits: ["report.internal"] } } });
  const bytes = Buffer.from("private bytes");
  const blobRef = await blobs.put(bytes, { mime: REPORT_MIME });
  const assetId = newId("asset");
  await db.insert(assets).values({
    id: assetId,
    userId: "user_test",
    path: "/reports/private.pdf",
    mime: REPORT_MIME,
    size: bytes.byteLength,
    sha256: blobRef.slice("sha256:".length),
    blobRef,
    currentVersion: 1,
  });
  await db.transaction((trx) =>
    publish(trx, {
      type: "report.internal",
      sourceTaskId: wf.taskIds.A!,
      packet: { report: { asset_id: assetId, path: "/reports/private.pdf", mime: REPORT_MIME, sha256: "x" } },
    }),
  );
  return { wf, assetId };
}

/**
 * One asset node declaring two event types over the same asset-ref shape — `report.ready`
 * (marked public) and `report.internal` (left private) — mirroring `sharing.test.ts`'s
 * `seedShared`: the difference between public and private is one flag, not one type being
 * undeclared.
 */
async function seedPublicAsset(
  db: Db,
  blobs: BlobStore,
): Promise<{ wf: SeededWorkflow; assetId: string; share: IssuedShare }> {
  const wf = await seedWorkflow(db, {
    tasks: {
      A: {
        kind: "asset",
        mode: "ai",
        emits: ["report.ready", "report.internal"],
        publicEvents: ["report.ready"],
      },
    },
  });

  const bytes = Buffer.from("%PDF-1.4 fake report bytes");
  const blobRef = await blobs.put(bytes, { mime: REPORT_MIME });
  const assetId = newId("asset");
  const sha256 = blobRef.slice("sha256:".length);
  await db.insert(assets).values({
    id: assetId,
    userId: "user_test",
    path: "/reports/x.pdf",
    mime: REPORT_MIME,
    size: bytes.byteLength,
    sha256,
    blobRef,
    currentVersion: 1,
  });

  const ref = { asset_id: assetId, path: "/reports/x.pdf", mime: REPORT_MIME, sha256 };
  await db.transaction((trx) =>
    publish(trx, { type: "report.ready", sourceTaskId: wf.taskIds.A!, packet: { report: ref } }),
  );
  await db.transaction((trx) =>
    publish(trx, { type: "report.internal", sourceTaskId: wf.taskIds.A!, packet: { report: ref } }),
  );

  const share = await createShare(db, { workflowId: wf.workflowId });
  return { wf, assetId, share };
}

function req(token: string, id: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/s/${token}/assets/${id}`, { headers });
}

function params(token: string, id: string): Promise<{ token: string; id: string }> {
  return Promise.resolve({ token, id });
}

it("publicAssetRef is undefined for an asset referenced only by a private-type packet", async () => {
  const { db, blobs } = await wireComposition();
  const { wf, assetId } = await seedPrivateAsset(db, blobs);

  const publicTypes = await publicEventTypes(db, wf.workflowId);
  expect([...publicTypes]).toEqual([]);
  const resolved = await publicAssetRef(db, { workflowId: wf.workflowId, publicTypes, assetId });
  expect(resolved).toBeUndefined();
});

it("publicAssetRef resolves the asset once its packet's event type is public", async () => {
  const { db, blobs } = await wireComposition();
  const { wf, assetId } = await seedPublicAsset(db, blobs);

  const publicTypes = await publicEventTypes(db, wf.workflowId);
  expect([...publicTypes]).toEqual(["report.ready"]);
  const resolved = await publicAssetRef(db, { workflowId: wf.workflowId, publicTypes, assetId });
  expect(resolved).toEqual({ blobRef: expect.stringMatching(/^sha256:/), mime: REPORT_MIME });
});

it("route: 200 with correct bytes and public headers once the packet's event type is public", async () => {
  const { db, blobs } = await wireComposition();
  const { assetId, share } = await seedPublicAsset(db, blobs);

  const res = await GET(req(share.token, assetId), { params: params(share.token, assetId) });
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe(REPORT_MIME);
  expect(res.headers.get("Content-Disposition")).toBe("attachment");
  expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
  expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
  expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");

  const body = Buffer.from(await res.arrayBuffer());
  expect(body.toString("utf8")).toBe("%PDF-1.4 fake report bytes");
});

it("route: 404 for an asset referenced only by a private-type packet", async () => {
  const { db, blobs } = await wireComposition();
  const { wf, assetId } = await seedPrivateAsset(db, blobs);
  const share = await createShare(db, { workflowId: wf.workflowId });

  const res = await GET(req(share.token, assetId), { params: params(share.token, assetId) });
  expect(res.status).toBe(404);
});

it("route: 404 for an unknown share token, a revoked share, and an unknown asset id", async () => {
  const { db, blobs } = await wireComposition();
  const { assetId, share } = await seedPublicAsset(db, blobs);

  const unknown = await GET(req("not-a-real-token", assetId), { params: params("not-a-real-token", assetId) });
  expect(unknown.status).toBe(404);

  const missingAsset = await GET(req(share.token, "asset_does_not_exist"), {
    params: params(share.token, "asset_does_not_exist"),
  });
  expect(missingAsset.status).toBe(404);

  await revokeShare(db, { shareId: share.id });
  const revoked = await GET(req(share.token, assetId), { params: params(share.token, assetId) });
  expect(revoked.status).toBe(404);
});

it("route: bursting past the per-share rate limit answers 429", async () => {
  const { db, blobs } = await wireComposition();
  const { share } = await seedPublicAsset(db, blobs);

  // A nonexistent asset id keeps every call on the cheap not-found path (share resolution +
  // one indexed lookup, no blob fetch) while still exercising both rate-limit checks —
  // distinct client keys per call so only the *per-share* bucket accumulates, isolating the
  // assertion to the bucket sharing.md §5.3 calls out.
  let sawRateLimited = false;
  for (let i = 0; i < 260 && !sawRateLimited; i++) {
    const headers = { "x-forwarded-for": `10.0.${Math.floor(i / 256)}.${i % 256}` };
    const res = await GET(req(share.token, "asset_burst_probe", headers), {
      params: params(share.token, "asset_burst_probe"),
    });
    if (res.status === 429) sawRateLimited = true;
    else expect(res.status).toBe(404);
  }
  expect(sawRateLimited).toBe(true);
});

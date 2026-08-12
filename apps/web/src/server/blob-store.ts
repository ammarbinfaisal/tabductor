import { loadConfig } from "@tabductor/core";
import { createMinioBlobStore, type BlobStore } from "@tabductor/browser/blob-store";

/**
 * The screenshot route's blob client (U1.5), memoized on `globalThis` for the same reason
 * `db()` is (`apps/web/src/server/db.ts`): Next's dev server re-evaluates modules on every
 * edit, and a fresh MinIO client per save would mean a fresh bucket-existence check per
 * save. The subpath import — `@tabductor/browser/blob-store`, not the package root — is
 * what keeps playwright-core out of this bundle; see the `package.json` exports map.
 */
const store = globalThis as { __tabductorBlobs?: BlobStore };

export function blobStore(): BlobStore {
  if (!store.__tabductorBlobs) {
    const cfg = loadConfig();
    store.__tabductorBlobs = createMinioBlobStore({
      endpoint: cfg.BLOB_ENDPOINT,
      accessKey: cfg.BLOB_ACCESS_KEY,
      secretKey: cfg.BLOB_SECRET_KEY,
      bucket: cfg.BLOB_BUCKET,
    });
  }
  return store.__tabductorBlobs;
}

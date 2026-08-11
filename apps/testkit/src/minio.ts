import { randomUUID } from "node:crypto";
import { createMinioBlobStore, type BlobStore } from "@tabductor/browser";
import { Client } from "minio";

/**
 * Defaults target the project's own MinIO container (`infra/README.md`) rather than a
 * system instance, for the same reason `db.ts`'s do: ports and creds on a dev box belong to
 * whoever claimed them first, and the suite should not lose a race with an unrelated project.
 */
const ENDPOINT = process.env.BLOB_ENDPOINT ?? "http://localhost:9002";
const ACCESS_KEY = process.env.BLOB_ACCESS_KEY ?? "tabductor";
const SECRET_KEY = process.env.BLOB_SECRET_KEY ?? "tabductor";

export type TestBlobStore = {
  store: BlobStore;
  bucket: string;
  /** Object keys actually written — the `BlobStore` interface has no listing method on
   * purpose, so a test that wants to see what landed needs the raw client. */
  list: () => Promise<string[]>;
  drop: () => Promise<void>;
};

function clientFor(endpoint: string): Client {
  const url = new URL(endpoint);
  return new Client({
    endPoint: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    useSSL: url.protocol === "https:",
    accessKey: ACCESS_KEY,
    secretKey: SECRET_KEY,
  });
}

/**
 * A throwaway bucket per test, mirroring `createTestDb`'s CREATE-DATABASE-per-test isolation:
 * cleanup is atomic, and a prefix scheme would force a prefix concept into the production
 * `BlobStore` API purely to scope tests. The bucket is created eagerly (the store itself
 * bootstraps lazily, on first `put`) so `list()` is valid before a test writes anything. A
 * connect error here means the compose `minio` service is down, not a bug in this helper.
 */
export async function createTestBlobStore(): Promise<TestBlobStore> {
  const bucket = `tabductor-test-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const client = clientFor(ENDPOINT);
  await client.makeBucket(bucket);

  const list = async (): Promise<string[]> => {
    const names: string[] = [];
    for await (const item of client.listObjectsV2(bucket, "", true)) {
      if (item.name) names.push(item.name);
    }
    return names;
  };

  return {
    store: createMinioBlobStore({
      endpoint: ENDPOINT,
      accessKey: ACCESS_KEY,
      secretKey: SECRET_KEY,
      bucket,
    }),
    bucket,
    list,
    drop: async () => {
      const names = await list();
      if (names.length > 0) await client.removeObjects(bucket, names);
      await client.removeBucket(bucket);
    },
  };
}

import { afterEach, beforeEach, expect, it } from "vitest";
import { AppError } from "@tabductor/core";
import { createTestBlobStore, type TestBlobStore } from "@tabductor/testkit";
import { Client } from "minio";

const ENDPOINT = process.env.BLOB_ENDPOINT ?? "http://localhost:9002";
const ACCESS_KEY = process.env.BLOB_ACCESS_KEY ?? "tabductor";
const SECRET_KEY = process.env.BLOB_SECRET_KEY ?? "tabductor";

// `statObject` isn't on `TestBlobStore` (the interface it stands in for has no listing or
// stat method either), so the one assertion that needs it talks to the bucket directly.
function rawClient(): Client {
  const url = new URL(ENDPOINT);
  return new Client({
    endPoint: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    useSSL: url.protocol === "https:",
    accessKey: ACCESS_KEY,
    secretKey: SECRET_KEY,
  });
}

let tb: TestBlobStore;

beforeEach(async () => {
  tb = await createTestBlobStore();
});

afterEach(async () => {
  await tb.drop();
});

it("writes identical bytes to one object and records the Content-Type", async () => {
  const bytes = Buffer.from("same bytes twice");
  const refA = await tb.store.put(bytes, { mime: "text/plain" });
  const refB = await tb.store.put(bytes, { mime: "text/plain" });
  expect(refB).toBe(refA);
  expect(await tb.list()).toEqual([refA.slice("sha256:".length)]);

  const stat = await rawClient().statObject(tb.bucket, refA.slice("sha256:".length));
  expect(stat.metaData["content-type"]).toBe("text/plain");
});

it("rejects a valid-shaped ref that was never written", async () => {
  const missing = `sha256:${"0".repeat(64)}`;
  await expect(tb.store.get(missing)).rejects.toThrow();
});

it("rejects a traversal payload before any client call", async () => {
  const err = await tb.store.get("../../etc/passwd").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe("blob_ref_invalid");
});

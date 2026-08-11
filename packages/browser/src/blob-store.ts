import { createHash } from "node:crypto";
import { Client } from "minio";
import { AppError } from "@tabductor/core";

/**
 * Where anything too big for a JSON column goes: screenshots now, response bodies and
 * rendered PDFs later. One method pair, deliberately — MinIO (the S3 API) is the store, and
 * a real S3 or R2 bucket differs from it in nothing but the endpoint; every extra method on
 * this interface is another thing that swap has to stay correct about.
 */
export type BlobRef = string;

export type BlobStore = {
  put: (bytes: Buffer, meta: { mime: string }) => Promise<BlobRef>;
  get: (ref: BlobRef) => Promise<Buffer>;
};

const REF_PATTERN = /^sha256:([0-9a-f]{64})$/;

export type MinioBlobStoreOptions = {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
};

/**
 * Content-addressed: the ref *is* the digest, so two screenshots of the same page cost one
 * object, a write is idempotent (a retried run re-uploads identical bytes onto the same key),
 * and a ref carries its own integrity check. The object key is the bare hex digest — no
 * `aa/bb/` fanout, that split existed only to keep one filesystem directory from holding too
 * many inodes, and an object store has no such concern. `meta.mime` becomes the object's
 * `Content-Type` (the filesystem predecessor dropped it on the floor, having nowhere to put
 * it), so a future reader — the run inspector, the asset MIME allowlist — gets it back from
 * `statObject` instead of a side channel.
 */
export function createMinioBlobStore(opts: MinioBlobStoreOptions): BlobStore {
  const url = new URL(opts.endpoint);
  const client = new Client({
    endPoint: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    useSSL: url.protocol === "https:",
    accessKey: opts.accessKey,
    secretKey: opts.secretKey,
  });

  // Memoized so concurrent `put`s share one bootstrap instead of racing `makeBucket`, and
  // reset on rejection so a bucket that wasn't up yet gets retried rather than wedging every
  // later `put` behind one stale failure.
  let ready: Promise<void> | undefined;
  function ensureBucket(): Promise<void> {
    ready ??= client
      .bucketExists(opts.bucket)
      .then((exists) => {
        if (!exists) return client.makeBucket(opts.bucket);
      })
      .catch((err: unknown) => {
        ready = undefined;
        // Two callers racing the bootstrap both see bucketExists=false and both call
        // makeBucket; the loser's error is the bucket existing, which is success here.
        const code = (err as { code?: string }).code;
        if (code === "BucketAlreadyOwnedByYou" || code === "BucketAlreadyExists") return;
        throw err;
      });
    return ready;
  }

  return {
    async put(bytes, meta) {
      const hex = createHash("sha256").update(bytes).digest("hex");
      await ensureBucket();
      await client.putObject(opts.bucket, hex, bytes, bytes.byteLength, {
        "Content-Type": meta.mime,
      });
      return `sha256:${hex}`;
    },

    async get(ref) {
      // The ref reaches this method from a database column, and a database column is where
      // a traversal payload would sit waiting (§16 Threat 8). Parsing it against the shape
      // we mint is the whole defence: there is no path component here that came from input.
      const match = REF_PATTERN.exec(ref);
      if (!match) {
        throw new AppError("blob_ref_invalid", `not a blob ref: ${ref}`, { details: { ref } });
      }
      // A ref that is shaped right but not present throws MinIO's own NoSuchKey — nobody
      // catches it, same as the filesystem predecessor's raw ENOENT.
      const stream = await client.getObject(opts.bucket, match[1]!);
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
      return Buffer.concat(chunks);
    },
  };
}

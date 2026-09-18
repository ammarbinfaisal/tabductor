import { createHash } from "node:crypto";
import { Client } from "minio";
import { AppError, type Config } from "@tabductor/core";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

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
  remove?: (ref: BlobRef) => Promise<void>;
};

const REF_PATTERN = /^sha256:([0-9a-f]{64})$/;

/** S3 buckets are provisioned by IaC. The app uses EKS workload identity, never bucket creation privileges. */
export function createS3BlobStore(opts: { bucket: string; region: string; client?: S3Client }): BlobStore {
  const client = opts.client ?? new S3Client({ region: opts.region });
  function key(ref: string) {
    const match = REF_PATTERN.exec(ref);
    if (!match) throw new AppError("blob_ref_invalid", "invalid blob reference");
    return match[1]!;
  }
  return {
    async put(bytes, meta) {
      const hash = createHash("sha256").update(bytes).digest("hex");
      await client.send(new PutObjectCommand({ Bucket: opts.bucket, Key: hash, Body: bytes, ContentType: meta.mime }));
      return `sha256:${hash}`;
    },
    async get(ref) {
      const result = await client.send(new GetObjectCommand({ Bucket: opts.bucket, Key: key(ref) }));
      if (!result.Body) throw new AppError("blob_missing", "object has no body");
      const bytes = Buffer.from(await result.Body.transformToByteArray());
      if (createHash("sha256").update(bytes).digest("hex") !== key(ref)) throw new AppError("blob_integrity_failed", "object digest does not match its reference");
      return bytes;
    },
    async remove(ref) { await client.send(new DeleteObjectCommand({ Bucket: opts.bucket, Key: key(ref) })); },
  };
}

export function configuredBlobStore(config: Pick<Config, "BLOB_DRIVER" | "BLOB_BUCKET" | "AWS_REGION" | "BLOB_ENDPOINT" | "BLOB_ACCESS_KEY" | "BLOB_SECRET_KEY">): BlobStore {
  return config.BLOB_DRIVER === "s3" ? createS3BlobStore({ bucket: config.BLOB_BUCKET, region: config.AWS_REGION })
    : createMinioBlobStore({ endpoint: config.BLOB_ENDPOINT, bucket: config.BLOB_BUCKET, accessKey: config.BLOB_ACCESS_KEY, secretKey: config.BLOB_SECRET_KEY });
}

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
 * it), so a future reader such as the run inspector gets it back from
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

    async remove(ref) {
      const match = REF_PATTERN.exec(ref);
      if (!match) throw new AppError("blob_ref_invalid", "invalid blob reference");
      await client.removeObject(opts.bucket, match[1]!);
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

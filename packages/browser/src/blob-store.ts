import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "@tabductor/core";

/**
 * Where anything too big for a JSON column goes: screenshots now, response bodies and
 * rendered PDFs later. One method pair, deliberately — the local filesystem today and S3
 * later differ in exactly this much, and every extra method is another thing the S3
 * implementation has to be correct about.
 */
export type BlobRef = string;

export type BlobStore = {
  put: (bytes: Buffer, meta: { mime: string }) => Promise<BlobRef>;
  get: (ref: BlobRef) => Promise<Buffer>;
};

const REF_PATTERN = /^sha256:([0-9a-f]{64})$/;

/**
 * Content-addressed: the ref *is* the digest, so two screenshots of the same page cost one
 * file, a write is idempotent (a retried run rewrites identical bytes), and a ref carries
 * its own integrity check. `meta.mime` is recorded by the caller on the row that points
 * here — it does not affect placement, because two identical byte strings are one blob
 * whatever anyone calls them.
 */
export function createFsBlobStore(root: string): BlobStore {
  const pathFor = (hex: string): string =>
    path.join(root, hex.slice(0, 2), hex.slice(2, 4), hex);

  return {
    async put(bytes) {
      const hex = createHash("sha256").update(bytes).digest("hex");
      const file = pathFor(hex);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
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
      return readFile(pathFor(match[1]!));
    },
  };
}

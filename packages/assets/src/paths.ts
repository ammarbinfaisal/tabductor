import { AppError } from "@tabductor/core";

/**
 * Asset-path validation (S5d, techical_plan §16 Threat 8). Paths come from LLM output, so
 * this is the one module the whole package trusts — every other file in `packages/assets`
 * hands its `path` argument through `normalizeAssetPath` before it touches the database or
 * `BlobStore`, and nowhere else re-derives this check.
 *
 * Crude is fine (`blob-store.ts`'s posture, reused deliberately): this is a hand-written,
 * table-tested reject list plus a resolve-and-reverify step, not a general path-security
 * library. No filesystem symlinks exist against a MinIO-backed store, but the shape is
 * still validated as if one might, so a future filesystem-backed `BlobStore` does not
 * reopen this threat by inheriting an under-validated path type.
 */

export const ASSET_PATH_INVALID = "asset_path_invalid";

function reject(rawPath: string, reason: string): AppError {
  return new AppError(ASSET_PATH_INVALID, `invalid asset path (${reason}): ${JSON.stringify(rawPath)}`, {
    details: { rawPath, reason },
  });
}

/** No dot segment, no backslash, no null byte, not empty/whitespace-only. Run twice — once
 * on the NFC form, once on its percent-decoded form — because either can carry the same
 * payload the other missed. */
function checkShape(rawPath: string, path: string): void {
  if (path.trim() === "") throw reject(rawPath, "empty");
  if (path.includes("\0")) throw reject(rawPath, "null byte");
  if (path.includes("\\")) throw reject(rawPath, "backslash");
  if (path.split("/").some((segment) => segment === "..")) throw reject(rawPath, "traversal segment");
}

/**
 * Percent-decodes repeatedly (capped, so a pathological input cannot loop forever) rather
 * than once — a double-encoded `%252e%252e` must not survive a single decode pass — and a
 * malformed escape (an overlong or truncated `%` sequence) is rejected outright rather than
 * passed through, since `decodeURIComponent` throwing is itself a sign the input was not
 * honestly a path.
 */
function percentDecode(rawPath: string, path: string): string {
  let current = path;
  for (let i = 0; i < 5; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      throw reject(rawPath, "malformed percent-encoding");
    }
    if (next === current) return next;
    current = next;
  }
  return current;
}

/** Joins `relative` onto `root`, resolving `.`/`..` by hand. Belt and suspenders: every
 * `..` segment was already rejected above, so this never actually pops past `root` — it
 * exists so a bug in the reject list is caught here too, by the prefix check that follows. */
function resolveWithinRoot(root: string, relative: string): string {
  const stack = root.split("/").filter(Boolean);
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return `/${stack.join("/")}`;
}

/**
 * `rawPath`, as the LLM wrote it, → the canonical path stored in `assets.path` — always a
 * single leading `/`, namespace-relative (`/reports/2026-q1.pdf`). Throws `AppError`
 * (`asset_path_invalid`) rather than returning a sentinel: every caller in this package
 * wants the reject to end the tool call, and a thrown, typed error is what the tool
 * wrapper's `try`/`catch` is built to turn into a `ToolResult`.
 *
 * Order is load-bearing: Unicode-normalize (NFC) *before* any check, not after — an
 * NFC-only-after check would let a combining-character sequence reassemble into `..` past
 * the point the check already ran. `userId` never appears in the returned path; it exists
 * only to build the `/users/<user_id>/...` root this function resolves against and
 * re-verifies, matching `unique(user_id, path)`'s own division of labour — the row's
 * `user_id` column is what actually scopes the path, not the string itself.
 */
export function normalizeAssetPath(userId: string, rawPath: string): string {
  const nfc = rawPath.normalize("NFC");
  checkShape(rawPath, nfc);
  if (nfc.startsWith("/")) throw reject(rawPath, "leading slash");

  const decoded = percentDecode(rawPath, nfc);
  checkShape(rawPath, decoded);
  if (decoded.startsWith("/")) throw reject(rawPath, "leading slash");

  const root = `/users/${userId}`;
  const resolved = resolveWithinRoot(root, decoded);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw reject(rawPath, "escapes user namespace");
  }

  return resolved.slice(root.length) || "/";
}

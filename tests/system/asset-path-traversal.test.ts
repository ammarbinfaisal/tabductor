import { expect, it } from "vitest";
import { AppError } from "@tabductor/core";
import { ASSET_PATH_INVALID, normalizeAssetPath } from "@tabductor/assets";

/**
 * The traversal corpus (S5d, techical_plan §16 Threat 8) — table-driven, extend on every
 * new idea, same discipline `blob-store.ts`'s `REF_PATTERN` check follows. Every entry here
 * must be rejected *before* it could reach `BlobStore`, which is why this file calls
 * `normalizeAssetPath` directly rather than going through a tool: the property under test
 * is "the reject list catches this," not "a tool call fails," and the tool tests
 * (`asset-store.test.ts`) already cover one instance of that end to end.
 */

const USER = "user_test";

const REJECTED: Array<{ name: string; path: string }> = [
  { name: "parent traversal", path: "../../etc/passwd" },
  { name: "absolute path", path: "/etc/passwd" },
  { name: "traversal after a real segment", path: "a/../../b" },
  { name: "percent-encoded traversal segment", path: "a/..%2f..%2fb" },
  { name: "double percent-encoded traversal", path: "%252e%252e/etc/passwd" },
  { name: "bare traversal segment", path: ".." },
  { name: "empty path", path: "" },
  { name: "whitespace-only path", path: "   " },
  { name: "backslash", path: "reports\\..\\secret.pdf" },
  { name: "null byte", path: "reports/\u0000hidden.pdf" },
  { name: "percent-encoded null byte", path: "reports/%00hidden.pdf" },
  { name: "percent-encoded leading slash", path: "%2fetc/passwd" },
  { name: "malformed percent-encoding", path: "reports/%zz.pdf" },
];

for (const { name, path } of REJECTED) {
  it(`rejects: ${name}`, () => {
    const err = ((): unknown => {
      try {
        normalizeAssetPath(USER, path);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(ASSET_PATH_INVALID);
  });
}

it("normalizes an ordinary relative path to a namespace-relative, leading-slash form", () => {
  expect(normalizeAssetPath(USER, "reports/2026-q1.pdf")).toBe("/reports/2026-q1.pdf");
});

it("collapses a leading ./ the same as its absence", () => {
  expect(normalizeAssetPath(USER, "./reports/2026-q1.pdf")).toBe("/reports/2026-q1.pdf");
});

it(
  "NFC runs before the check, not after: a decomposed and a precomposed form of the same " +
    "character normalize to the identical stored path",
  () => {
    // "e" (U+0065) + combining acute accent (U+0301) vs. the precomposed "é" — an
    // NFC-*after* check would see two different byte sequences here; this one sees one.
    const decomposed = normalizeAssetPath(USER, "reports/café.pdf");
    const precomposed = normalizeAssetPath(USER, "reports/café.pdf");
    expect(decomposed).toBe(precomposed);
  },
);

it("does not leak one user's resolution into another's — same rawPath, different roots", () => {
  const a = normalizeAssetPath("user_a", "reports/x.pdf");
  const b = normalizeAssetPath("user_b", "reports/x.pdf");
  // Both normalize to the same namespace-relative string; the row's `user_id` column, not
  // the path text, is what actually separates them (`assets_user_path_key`).
  expect(a).toBe(b);
  expect(a).toBe("/reports/x.pdf");
});

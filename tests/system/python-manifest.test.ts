import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PYTHON_RUNTIME_MANIFEST } from "@tabductor/core";
import { expect, it } from "vitest";

/**
 * The manifest and the image's requirements must name the same set.
 *
 * These are the two halves of one claim made in two places: `checkGraph` validates a task's
 * declared `runtime.packages` against `PYTHON_RUNTIME_MANIFEST` at publish, and
 * `apps/pyrunner/requirements.txt` is what the image actually installs. Drift between them is
 * silent in the worst direction — a publish that passes the gate and then fails at import time
 * inside a job, long after the author has stopped looking.
 *
 * This is also what lets the rest of the S5h suite run pyrunner in-process rather than
 * containerised: the pinned set is the one thing the built image uniquely provides, and this
 * test covers it without a five-minute image build in the test loop.
 */

const REQUIREMENTS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "apps",
  "pyrunner",
  "requirements.txt",
);

/** `name==version`, comments and blanks dropped. Deliberately strict: an unpinned line is a
 * reproducibility hole, so it fails here rather than parsing loosely around it. */
function requirementNames(): string[] {
  return readFileSync(REQUIREMENTS, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const [name, version] = line.split("==");
      expect(version, `requirements.txt line is not pinned with ==: "${line}"`).toBeTruthy();
      return name!.trim();
    });
}

it("the py-2026.08 manifest and requirements.txt name the same packages", () => {
  const manifest = [...(PYTHON_RUNTIME_MANIFEST["py-2026.08"] ?? [])].sort();
  const installed = requirementNames().sort();
  expect(manifest).toHaveLength(installed.length);
  expect(manifest).toEqual(installed);
});

it("every manifest image is a non-empty pinned set", () => {
  const images = Object.keys(PYTHON_RUNTIME_MANIFEST);
  expect(images.length).toBeGreaterThan(0);
  for (const image of images) {
    expect(PYTHON_RUNTIME_MANIFEST[image]!.length, `${image} declares no packages`).toBeGreaterThan(0);
  }
});

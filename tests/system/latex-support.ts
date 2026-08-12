import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createLogger } from "@tabductor/core";
import type { RenderClient, RenderOutcome } from "@tabductor/assets";
import type { RendererServer } from "../../apps/renderer/src/server.js";
import { startRendererServer } from "../../apps/renderer/src/server.js";

/**
 * Rig for the S5e system tests (`latex-renderer.test.ts`, `latex-hostile-corpus.test.ts`).
 * Starts the *real* `apps/renderer` HTTP server in-process (same pattern
 * `tests/system/*.test.ts` already uses for `apps/web` — a direct relative import, no package
 * boundary needed for test-only code) and points it at the real, containerised sandbox image
 * built from `apps/renderer/sandbox/Dockerfile`.
 *
 * **Docker is a baseline requirement of this whole test environment already** (Postgres and
 * MinIO run as containers, `docs/subphases/ROADMAP.md`) — so unlike S5h's Firecracker gate
 * (which needs `/dev/kvm`, a genuinely optional piece of hardware), there is no expected
 * environment here where Docker is present but this suite cannot run. `ensureSandboxImage`
 * still fails loudly rather than silently substituting anything if `docker` turns out to be
 * unavailable: `describeIfDocker` skips the whole file with a visible reason instead of the
 * suite quietly turning into a test of a bare, unsandboxed `tectonic` — the exact substitution
 * S5e's own spec (and S5h's Firecracker-vs-subprocess precedent) forbids.
 */

const execFileAsync = promisify(execFile);

export const SANDBOX_IMAGE = "tabductor-renderer-sandbox:test";
const SANDBOX_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "renderer", "sandbox");

let dockerAvailable: Promise<boolean> | undefined;
/** Checked once per test process; the image build below is the expensive part, not this. */
export function dockerIsAvailable(): Promise<boolean> {
  dockerAvailable ??= execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"])
    .then(() => true)
    .catch(() => false);
  return dockerAvailable;
}

let imageReady: Promise<void> | undefined;
/**
 * Builds the sandbox image once per test process if it is not already present (subsequent
 * `pnpm test` runs hit Docker's own layer cache and this resolves in milliseconds). The
 * pre-warm step downloads a real package set at build time — several minutes cold — which is
 * why the caller's `beforeAll` needs a generous timeout, not vitest's default.
 */
export function ensureSandboxImage(): Promise<void> {
  imageReady ??= (async () => {
    const exists = await execFileAsync("docker", ["image", "inspect", SANDBOX_IMAGE])
      .then(() => true)
      .catch(() => false);
    if (exists) return;
    await execFileAsync("docker", ["build", "-t", SANDBOX_IMAGE, SANDBOX_DIR], {
      maxBuffer: 64 * 1024 * 1024,
    });
  })();
  return imageReady;
}

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "apps",
  "testkit",
  "fixtures",
  "latex",
);

/** A checked-in `.tex`/binary fixture (`apps/testkit/fixtures/latex/*`, impl-phases.md's
 * "LaTeX fixtures" test-infrastructure bullet). */
export function readFixture(name: string): Buffer {
  return readFileSync(path.join(FIXTURES_DIR, name));
}
export function readFixtureText(name: string): string {
  return readFixture(name).toString("utf8");
}

/**
 * Normalizes away the parts of a tectonic PDF that vary run to run without the *document*
 * changing at all — confirmed by direct comparison against the real sandbox, twice: the
 * rendered content (every object up to the cross-reference stream) is byte-identical for an
 * identical `.tex` input, but the trailing cross-reference stream + trailer — the `/ID` pair,
 * and the compressed object-offset table that embeds it — is not, because tectonic's object
 * ordering/offsets shift with the random `/ID` it mints per run. Truncating at that object's
 * start (rather than pattern-matching individual fields inside it) is what "normalize
 * timestamps and document IDs before asserting... do not chase byte-identity by accident"
 * (S5e spec) means in practice for this tail: it is bookkeeping about the file, not content
 * in it. `/CreationDate`/`/ModDate` are stripped from whatever body text remains too, on the
 * same principle the S5h `.xlsx` fixtures use — normalizing a field that happens to already
 * be absent here is a no-op, not a risk, if a future tectonic version starts emitting one.
 */
export function normalizePdfBytes(pdf: Buffer): Buffer {
  const text = pdf.toString("latin1");
  const xrefObjIdx = text.search(/\d+ 0 obj\s*<<[^>]*\/Type\s*\/XRef/);
  const body = xrefObjIdx === -1 ? text : text.slice(0, xrefObjIdx);
  const normalized = body
    .replace(/\/CreationDate\s*\([^)]*\)/g, "/CreationDate()")
    .replace(/\/ModDate\s*\([^)]*\)/g, "/ModDate()");
  return Buffer.from(normalized, "latin1");
}

export type LatexRig = { server: RendererServer; scratchRoot: string; stop: () => Promise<void> };

export async function startLatexRig(): Promise<LatexRig> {
  await ensureSandboxImage();
  const scratchRoot = mkdtempSync(path.join(tmpdir(), "tabductor-render-scratch-"));
  const server = await startRendererServer({
    sandbox: {
      image: SANDBOX_IMAGE,
      // Short, test-scale wall clock; a generous memory cap — this rig backs the *contract*
      // tests (happy path, retry, deck, image resolution), not the hostile corpus, and
      // tectonic's own bookkeeping grows some memory per render even for an ordinary
      // document, so a tight cap here would misattribute an unrelated OOM as a document
      // defect. `latex-hostile-corpus.test.ts` uses its own, separately-tuned tight cap for
      // the memory-bomb case specifically.
      wallClockMs: 15_000,
      memoryBytes: 512 * 1024 * 1024,
      pidsLimit: 32,
      scratchRoot,
    },
    logger: createLogger({ name: "latex-test-renderer", level: "error" }),
    maxConcurrent: 4,
  });
  return {
    server,
    scratchRoot,
    stop: async () => {
      await server.close();
      // `sandbox.ts` removes each *per-render* subdirectory itself; this is the mkdtemp
      // root the rig created above and owns.
      const { rm } = await import("node:fs/promises");
      await rm(scratchRoot, { recursive: true, force: true });
    },
  };
}

/** Wraps a real `RenderClient` with a call counter — how the docx-rejection and
 * write-grant-denial tests prove the sandbox was never invoked, not just that the tool
 * returned an error shape (S5e deliverable 3: "proving it never reached the sandbox is the
 * point"). */
export function countingRenderClient(inner: RenderClient): RenderClient & { callCount: () => number } {
  let calls = 0;
  return {
    callCount: () => calls,
    render: async (job): Promise<RenderOutcome> => {
      calls++;
      return inner.render(job);
    },
  };
}

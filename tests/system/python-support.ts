import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createLogger } from "@tabductor/core";
import { inflateRawSync } from "node:zlib";
import type { JobConfig } from "../../apps/pyrunner/src/job.js";
import type { PyrunnerServer } from "../../apps/pyrunner/src/server.js";
import { startPyrunnerServer } from "../../apps/pyrunner/src/server.js";

/**
 * Rig for the S5h system tests. Starts the *real* `apps/pyrunner` HTTP server in-process, the
 * same direct-relative-import pattern `latex-support.ts` uses for `apps/renderer`.
 *
 * **In-process, not the built container — deliberately.** The renderer's rig builds its image
 * because the container *is* the boundary under test. After the S5h reshape nothing here is
 * container-specific: a job is a subprocess, and the same subprocess runs identically on the
 * host. Cold-building a Debian-plus-scientific-stack image on every `pnpm test` would cost
 * minutes and buy no coverage. The one thing the image uniquely provides — the pinned package
 * set — is covered instead by `python-manifest.test.ts` (the manifest and requirements.txt
 * must name the same set) plus the module probes below, which skip loudly.
 */

const execFileAsync = promisify(execFile);

export const PYTHON_BIN = process.env.PYRUNNER_PYTHON ?? "python3";

let pythonProbe: Promise<boolean> | undefined;
/** Checked once per test process. */
export function pythonIsAvailable(): Promise<boolean> {
  pythonProbe ??= execFileAsync(PYTHON_BIN, ["-c", "import sys"])
    .then(() => true)
    .catch(() => false);
  return pythonProbe;
}

const moduleProbes = new Map<string, Promise<boolean>>();
/**
 * True when every named module imports. Suites gate on this and skip **with a visible
 * reason** — never silently, and never by quietly asserting something weaker instead.
 */
export function pythonHasModules(names: string[]): Promise<boolean> {
  const key = names.join(",");
  let probe = moduleProbes.get(key);
  if (!probe) {
    probe = execFileAsync(PYTHON_BIN, ["-c", names.map((n) => `import ${n}`).join("; ")])
      .then(() => true)
      .catch(() => false);
    moduleProbes.set(key, probe);
  }
  return probe;
}

export type PyRig = {
  server: PyrunnerServer;
  scratchRoot: string;
  config: JobConfig;
  stop: () => Promise<void>;
};

/** Test-scale caps: small enough that a cap test does not have to write megabytes to trip one. */
export async function startPyrunnerRig(overrides: Partial<JobConfig> = {}): Promise<PyRig> {
  const scratchRoot = await mkdtemp(path.join(tmpdir(), "tabductor-pyrun-"));
  const config: JobConfig = {
    python: PYTHON_BIN,
    wallClockMs: 10_000,
    scratchRoot,
    maxOutputFiles: 8,
    maxOutputBytes: 1024 * 1024,
    maxFileBytes: 512 * 1024,
    maxEmitLines: 20,
    maxEmitBytes: 64 * 1024,
    maxLogBytes: 8 * 1024,
    keepJobs: false,
    ...overrides,
  };
  const server = await startPyrunnerServer({
    job: config,
    logger: createLogger({ name: "pyrunner-test", level: "error" }),
    maxConcurrent: 2,
    port: 0,
  });
  return {
    server,
    scratchRoot,
    config,
    stop: async () => {
      await server.close();
      await rm(scratchRoot, { recursive: true, force: true });
    },
  };
}

export type RunResponse = Record<string, unknown> & { ok: boolean };

/** POSTs a job the way `packages/engine`'s client will, so the tests exercise the real route. */
export async function postRun(
  rig: PyRig,
  body: {
    code: string;
    trigger?: unknown;
    assets?: { filename: string; contentBase64: string }[];
    sourceDateEpoch?: number;
    wallClockMs?: number;
  },
): Promise<RunResponse> {
  const res = await fetch(`${rig.server.url}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      trigger: null,
      assets: [],
      sourceDateEpoch: 1_700_000_000,
      ...body,
    }),
  });
  return (await res.json()) as RunResponse;
}

/**
 * The `.xlsx` analogue of `normalizePdfBytes`. A workbook is a zip, and both the archive
 * framing (entry mtimes, compression choices) and two fields inside `docProps/core.xml` move
 * between otherwise identical runs. Rather than chase those bytes with pattern matches, parse
 * the archive, inflate each member, blank the two timestamp fields, and return a canonical
 * serialization of (name, content) sorted by name — comparing what the workbook *is* rather
 * than how this particular zip encoder happened to lay it out.
 */
export function normalizeXlsxBytes(buf: Buffer): string {
  const members: { name: string; content: string }[] = [];
  // Walk the central directory, which is the only reliable index of a zip's members.
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("not a zip: no end-of-central-directory record");
  let offset = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== 0x0201_4b50) throw new Error("bad central directory header");
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");

    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    const content = (method === 0 ? raw : inflateRawSync(raw)).toString("utf8");

    members.push({ name, content });
    offset += 46 + nameLen + extraLen + commentLen;
  }

  return members
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map(({ name, content }) => {
      const scrubbed = content
        .replace(/<dcterms:created[^>]*>[^<]*<\/dcterms:created>/g, "<dcterms:created/>")
        .replace(/<dcterms:modified[^>]*>[^<]*<\/dcterms:modified>/g, "<dcterms:modified/>")
        .replace(/<cp:revision>[^<]*<\/cp:revision>/g, "<cp:revision/>");
      return `${name}\n${scrubbed}`;
    })
    .join("\n---\n");
}

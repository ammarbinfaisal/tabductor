import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

/**
 * One Python job: a directory, a subprocess, and whatever the program left behind.
 *
 * **There is no sandbox here, and that is the design.** tabductor is self-hosted open source;
 * the program a `mode=python` task runs is the operator's own code, published through their own
 * control plane. The threat model that justified a Firecracker microVM (an untrusted tenant's
 * program on shared infrastructure) does not exist, so the microVM, the jailer, the vendored
 * kernel and the ext4 block-device protocol are all gone. The `pyrunner` **container** is the
 * unit of isolation, and the only runtime control left is the wall clock below.
 *
 * What survives the reshape unchanged is the *channel* argument, which was never a property of
 * the VM: a Python program has no host bridge. Its inputs are resolved and written before it
 * starts, its outputs are read after it exits, and in between it can call nothing. That is why
 * `(asset, python)`'s tool registry is empty rather than filtered
 * (`packages/agent/src/python-tools.ts`) — there is no call for a tool to intercept.
 *
 * The host still validates every output path before writing it into the asset store, but that
 * happens in `packages/engine/src/python-executor.ts`, not here: it is host integrity, not
 * tenant isolation, and this process is a network peer whose response is untrusted input like
 * any other.
 */

export type JobConfig = {
  /** Interpreter path. The image sets this to its venv's python; dev uses `python3`. */
  python: string;
  wallClockMs: number;
  scratchRoot: string;
  maxOutputFiles: number;
  maxOutputBytes: number;
  maxFileBytes: number;
  maxEmitLines: number;
  maxEmitBytes: number;
  maxLogBytes: number;
  /** Leave job directories on disk for debugging. Never on in compose. */
  keepJobs: boolean;
};

export type JobAsset = { filename: string; bytes: Buffer };

export type Job = {
  code: string;
  trigger: unknown;
  assets: JobAsset[];
  /** Seconds. Becomes `SOURCE_DATE_EPOCH`, so a rerun of the same trigger is byte-stable. */
  sourceDateEpoch: number;
  wallClockMs?: number;
};

export type OutputCapLimit = "file_count" | "file_bytes" | "total_bytes" | "emit_lines" | "emit_bytes";

export type JobOutcome =
  | {
      ok: true;
      durationMs: number;
      /** Paths relative to `out/files`, POSIX-separated. Regular files only. */
      files: { path: string; contentBase64: string }[];
      emitsJsonl: string;
      stdout: string;
      stderr: string;
      /** Symlinks, directories and anything else not a regular file, counted not extracted. */
      skipped: { nonRegular: number };
      truncated: { stdout: boolean; stderr: boolean };
    }
  | { ok: false; kind: "program_error"; exitCode: number; stdout: string; stderr: string; durationMs: number }
  | { ok: false; kind: "killed"; reason: "wall_clock"; stdout: string; stderr: string; durationMs: number }
  | { ok: false; kind: "output_cap"; limit: OutputCapLimit; durationMs: number };

/** Grows to a cap and then stops, remembering that it did. The stream is still drained — a
 * child that blocks writing to a full pipe never reaches its own exit. */
class CappedBuffer {
  private parts: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly limit: number) {}
  push(chunk: Buffer): void {
    if (this.size >= this.limit) {
      this.truncated = true;
      return;
    }
    const room = this.limit - this.size;
    if (chunk.length > room) {
      this.parts.push(chunk.subarray(0, room));
      this.size = this.limit;
      this.truncated = true;
      return;
    }
    this.parts.push(chunk);
    this.size += chunk.length;
  }
  toString(): string {
    return Buffer.concat(this.parts).toString("utf8");
  }
}

async function collectEmits(
  outDir: string,
  config: JobConfig,
): Promise<{ ok: true; jsonl: string } | { ok: false; limit: OutputCapLimit }> {
  const file = path.join(outDir, "emits.jsonl");
  // `lstat`, not `stat`: a symlink where the file should be is treated as absent rather than
  // followed. And the size gate has to fire *before* any read — a single 100 MB line must be
  // refused without ever allocating a buffer for it, which only a stat-first check guarantees.
  const stat = await lstat(file).catch(() => undefined);
  if (!stat || !stat.isFile()) return { ok: true, jsonl: "" };
  if (stat.size > config.maxEmitBytes) return { ok: false, limit: "emit_bytes" };

  const lines: string[] = [];
  const reader = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (line.trim() === "") continue;
      lines.push(line);
      if (lines.length > config.maxEmitLines) return { ok: false, limit: "emit_lines" };
    }
  } finally {
    reader.close();
  }
  return { ok: true, jsonl: lines.join("\n") };
}

async function collectFiles(
  filesDir: string,
  config: JobConfig,
): Promise<
  | { ok: true; files: { path: string; contentBase64: string }[]; skippedNonRegular: number; totalBytes: number }
  | { ok: false; limit: OutputCapLimit }
> {
  const files: { path: string; contentBase64: string }[] = [];
  let skippedNonRegular = 0;
  let totalBytes = 0;

  // Only ever recurses into `Dirent`s read from a directory it already holds, and never
  // resolves a caller-supplied string — so this walk cannot itself be traversed out of. A
  // path *named* `../../etc/passwd` is rejected host-side, where it would be written.
  async function walk(dir: string, prefix: string): Promise<{ ok: false; limit: OutputCapLimit } | undefined> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
        skippedNonRegular++;
        continue;
      }
      if (entry.isDirectory()) {
        const failed = await walk(abs, rel);
        if (failed) return failed;
        continue;
      }
      const stat = await lstat(abs);
      if (stat.size > config.maxFileBytes) return { ok: false, limit: "file_bytes" };
      totalBytes += stat.size;
      if (totalBytes > config.maxOutputBytes) return { ok: false, limit: "total_bytes" };
      if (files.length + 1 > config.maxOutputFiles) return { ok: false, limit: "file_count" };
      files.push({ path: rel, contentBase64: (await readFile(abs)).toString("base64") });
    }
    return undefined;
  }

  const failed = await walk(filesDir, "");
  if (failed) return failed;
  return { ok: true, files, skippedNonRegular, totalBytes };
}

export async function runJob(config: JobConfig, job: Job): Promise<JobOutcome> {
  const root = path.join(config.scratchRoot, `pyrun-${randomUUID()}`);
  const outDir = path.join(root, "out");
  const filesDir = path.join(outDir, "files");
  const tmpDir = path.join(root, "tmp");
  const started = Date.now();

  try {
    await mkdir(path.join(root, "code"), { recursive: true });
    await mkdir(path.join(root, "in", "assets"), { recursive: true });
    await mkdir(filesDir, { recursive: true });
    await mkdir(path.join(tmpDir, "mpl"), { recursive: true });

    await writeFile(path.join(root, "code", "main.py"), job.code, "utf8");
    await writeFile(path.join(root, "in", "trigger.json"), JSON.stringify(job.trigger ?? null), "utf8");
    for (const asset of job.assets) {
      await writeFile(path.join(root, "in", "assets", asset.filename), asset.bytes);
    }

    const stdout = new CappedBuffer(config.maxLogBytes);
    const stderr = new CappedBuffer(config.maxLogBytes);

    // `-s -B`, deliberately **not** `-I`. `-I` implies `-E`, and `-E` ignores every `PYTHON*`
    // variable — including `PYTHONHASHSEED`. Pairing `-I` with `PYTHONHASHSEED=0`, as the
    // original spec did, cancels itself: hash randomization stays on, `set` iteration order
    // varies run to run, and a byte-stability assertion becomes flaky by construction
    // (verified: under `-I`, `hash('x')` differs every run; under `-s -B` it does not).
    // `-E`'s remaining value — ignoring PYTHONPATH/PYTHONHOME — is obtained structurally
    // instead, by passing an explicit env with no `...process.env` spread, so those variables
    // are absent rather than ignored.
    const child = spawn(config.python, ["-s", "-B", "code/main.py"], {
      cwd: root,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: tmpDir,
        TMPDIR: tmpDir,
        TZ: "UTC",
        LC_ALL: "C.UTF-8",
        PYTHONHASHSEED: "0",
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONNOUSERSITE: "1",
        PYTHONUNBUFFERED: "1",
        SOURCE_DATE_EPOCH: String(job.sourceDateEpoch),
        MPLBACKEND: "Agg",
        MPLCONFIGDIR: path.join(tmpDir, "mpl"),
        TABDUCTOR_JOB_DIR: root,
      },
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so the kill below reaches anything the program forked.
      detached: true,
    });
    child.stdout.on("data", (d: Buffer) => stdout.push(d));
    child.stderr.on("data", (d: Buffer) => stderr.push(d));

    let killed = false;
    const budget = Math.min(job.wallClockMs ?? config.wallClockMs, config.wallClockMs);
    const timer = setTimeout(() => {
      killed = true;
      // Negative pid: the whole group. Killing only the direct child leaves a forked
      // grandchild holding the pipes open, and `close` never fires.
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }, budget);

    const exitCode = await new Promise<number>((resolve) => {
      child.on("error", () => resolve(-1));
      child.on("close", (code) => resolve(code ?? -1));
    });
    clearTimeout(timer);
    const durationMs = Date.now() - started;

    await writeFile(path.join(outDir, "stdout"), stdout.toString(), "utf8");
    await writeFile(path.join(outDir, "stderr"), stderr.toString(), "utf8");
    await writeFile(
      path.join(outDir, "_status.json"),
      JSON.stringify({ exitCode, durationMs, killed }),
      "utf8",
    );

    // `killed` is what *this* code decided, never inferred from the exit code: a SIGKILLed
    // process and a `sys.exit(137)` are indistinguishable from out here.
    if (killed) {
      return { ok: false, kind: "killed", reason: "wall_clock", stdout: stdout.toString(), stderr: stderr.toString(), durationMs };
    }
    if (exitCode !== 0) {
      return { ok: false, kind: "program_error", exitCode, stdout: stdout.toString(), stderr: stderr.toString(), durationMs };
    }

    // Only a clean exit collects: emits publish after the program succeeded, never from a
    // half-finished run that happened to write a line before dying.
    const emits = await collectEmits(outDir, config);
    if (!emits.ok) return { ok: false, kind: "output_cap", limit: emits.limit, durationMs };
    const collected = await collectFiles(filesDir, config);
    if (!collected.ok) return { ok: false, kind: "output_cap", limit: collected.limit, durationMs };

    return {
      ok: true,
      durationMs,
      files: collected.files,
      emitsJsonl: emits.jsonl,
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      skipped: { nonRegular: collected.skippedNonRegular },
      truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
    };
  } finally {
    if (!config.keepJobs) await rm(root, { recursive: true, force: true });
  }
}

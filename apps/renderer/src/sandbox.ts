import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The actual `docker run` invocation — one fresh container per render, discarded after
 * (`docs/subphases/S5e-latex-renderer.md` deliverable 1: "scratch dirs are never shared
 * across renders, even concurrent ones"). Everything in this file runs on the host side of
 * the sandbox boundary; the container it launches (`apps/renderer/sandbox/Dockerfile`) is the
 * boundary itself — no network namespace, read-only rootfs except the one bind-mounted
 * scratch dir, `FROM scratch` so there is nothing in the image an escape could reach or exec.
 *
 * **Two structural controls, not runtime ones**, both true regardless of anything this file
 * does: shell escape is absent from the sandbox image (`TECTONIC_UNTRUSTED_MODE=1` baked into
 * the image, `--untrusted` passed again here — belt-and-suspenders, see the Dockerfile
 * comment), and there is no host filesystem reachable from inside the container at all — not
 * "reachable but denied", genuinely absent, because the image was built `FROM scratch` and
 * the only bind mount is the fresh scratch dir. **Two runtime controls**, enforced by the
 * container runtime/cgroups and requiring this file's active intervention: the wall-clock
 * timer below (`docker kill` on expiry) and the `--memory`/`--memory-swap` cap (cgroup
 * OOM-kills the process; detected here via `docker inspect`'s `OOMKilled` field). The
 * distinction matters enough that `render_sandbox_kills_total{reason}` only ever fires for
 * the second pair — a structural control has nothing to report a *kill* for, because nothing
 * ever got far enough to need killing.
 */

export type SandboxKillReason = "wall_clock" | "memory";

export type SandboxOutcome =
  | { ok: true; pdf: Buffer }
  | { ok: false; kind: "compile_error"; log: string }
  | { ok: false; kind: "killed"; reason: SandboxKillReason; log: string };

export type SandboxConfig = {
  /** `apps/renderer/sandbox/Dockerfile`'s built image — `docker build -t <image> sandbox/`. */
  image: string;
  wallClockMs: number;
  memoryBytes: number;
  pidsLimit: number;
  /** Parent directory for per-render scratch dirs; defaults to `os.tmpdir()` at the call site. */
  scratchRoot: string;
};

export type SandboxJob = {
  texSource: string;
  files: { filename: string; bytes: Buffer }[];
};

/** Bare filenames only — no path separators, no leading dot — matching the tool-input
 * contract render.ts enforces on its side too (defense in depth: even if that check were
 * ever bypassed, a filename shaped like a path never reaches `writeFile` unvalidated here). */
const FILENAME_RE = /^[\w.-]+$/;

function runDocker(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn("docker", args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.on("error", (err) => resolve({ stdout, stderr: String(err), code: 1 }));
  });
}

export async function runInSandbox(config: SandboxConfig, job: SandboxJob): Promise<SandboxOutcome> {
  const scratchDir = join(config.scratchRoot, `render-${randomUUID()}`);
  const containerName = `tabductor-render-${randomUUID()}`;
  await mkdir(scratchDir, { recursive: true });
  // World-writable: the container runs as an unprivileged, fixed numeric uid (65534) that
  // owns nothing on the host, and this directory is a fresh, single-use scratch dir created
  // and destroyed by this function — there is nothing else in it to protect from the host's
  // own other users.
  await chmod(scratchDir, 0o777);

  try {
    for (const f of job.files) {
      if (!FILENAME_RE.test(f.filename)) {
        return { ok: false, kind: "compile_error", log: `rejected: invalid image filename "${f.filename}"` };
      }
    }
    await writeFile(join(scratchDir, "main.tex"), job.texSource, "utf8");
    for (const f of job.files) {
      await writeFile(join(scratchDir, f.filename), f.bytes);
    }

    const args = [
      "run",
      "--name",
      containerName,
      // No `--rm`: this function inspects the container's exit state (OOMKilled) before
      // removing it itself in the `finally` below, so no run — successful, killed, or
      // errored — ever leaks a container past this function returning.
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--pids-limit",
      String(config.pidsLimit),
      "--memory",
      String(config.memoryBytes),
      "--memory-swap",
      String(config.memoryBytes), // equal to --memory: no swap, so the cap is real.
      "-v",
      `${scratchDir}:/work:rw`,
      "--user",
      "65534:65534",
      config.image,
      // The image's ENTRYPOINT is tectonic itself; everything below this line is tectonic's
      // own argv. `--untrusted` a second time (already baked in via TECTONIC_UNTRUSTED_MODE)
      // and `--only-cached` so a package this render needs but the image never pre-warmed
      // fails closed instead of trying — and failing — a network fetch that cannot succeed
      // anyway (`--network none`). `-Z deterministic-mode` is not a security control — it is
      // what makes the happy-path fixture test's byte-stability assertion meaningful at all:
      // without it, tectonic mints a random document `/ID` (expected, and still normalized
      // away by the test) *and* a font-subsetter timestamp buried inside a compressed font
      // stream (not expected, and not practically normalizable by pattern-matching bytes).
      // `--synctex` is never passed, so the one thing this flag is documented to break never
      // comes up.
      "--untrusted",
      "--only-cached",
      "--keep-logs",
      "-Z",
      "deterministic-mode",
      "-o",
      "/work",
      "/work/main.tex",
    ];

    let timedOut = false;
    const runPromise = runDocker(args);
    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL by default — a render that ignored the wall clock this long does not get a
      // grace period to clean up after itself.
      void runDocker(["kill", containerName]);
    }, config.wallClockMs);

    const { stdout, stderr, code } = await runPromise;
    clearTimeout(timer);

    const inspect = await runDocker(["inspect", containerName, "--format", "{{.State.OOMKilled}}"]);
    const oomKilled = inspect.code === 0 && inspect.stdout.trim() === "true";

    const combinedLog = [stderr, stdout].filter(Boolean).join("\n").trim();

    // Order matters: a wall-clock `docker kill` also leaves the container exiting non-zero
    // (often the same 137 an OOM-kill produces), so `timedOut` — set the instant *this*
    // function decided to kill it, not inferred from the exit code — takes priority. Only
    // when the render was not killed by the wall clock do we ask whether the cgroup killed
    // it for memory.
    if (timedOut) {
      return { ok: false, kind: "killed", reason: "wall_clock", log: combinedLog || "wall-clock limit exceeded" };
    }
    if (oomKilled) {
      return { ok: false, kind: "killed", reason: "memory", log: combinedLog || "memory limit exceeded" };
    }
    if (code !== 0) {
      return { ok: false, kind: "compile_error", log: combinedLog || `tectonic exited ${code}` };
    }

    const pdf = await readFile(join(scratchDir, "main.pdf"));
    return { ok: true, pdf };
  } finally {
    await runDocker(["rm", "-f", containerName]);
    await rm(scratchDir, { recursive: true, force: true });
  }
}

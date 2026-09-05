import path from "node:path";
import { checkWriteGrant, normalizeAssetPath, putVersion, type AssetToolDeps } from "@tabductor/assets";
import { AppError, PYTHON_RUNTIME_MANIFEST, type AssetRef } from "@tabductor/core";
import { assets } from "@tabductor/db";
import type { PyrunClient } from "@tabductor/engine/python";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { untrustedBlock, type AgentTool, type ToolResult } from "./tools.js";

/**
 * `python.run` — the asset node's compute tool. **Always on the registry** for `(asset, ai)`:
 * an asset node can compute, full stop, the same way it can write a file. What the author
 * used to declare as a separate `mode=python` task with a hand-written program is now a
 * program the model writes when the job calls for one — a spreadsheet, a chart, a
 * transformation the other tools cannot express.
 *
 * The isolation argument from S5h survives unchanged, because it never depended on the mode:
 * the program talks to the host through a directory and an exit code, not through a call.
 * `apps/pyrunner` gets bytes in, returns bytes out, and every privileged act — resolving
 * inputs from the asset store, writing outputs into it under the task's write grants — is
 * done here, host-side, after validating what came back. Everything pyrunner returns is
 * untrusted input: a filename is a filename whatever wrote it.
 *
 * Without a `PYRUNNER_URL` the tool still exists and fails closed with a clear error, the
 * `assets.render` precedent — the model learns the ability is unavailable from a tool result
 * rather than the whole node kind losing a tool it was documented to have.
 */

export const PYTHON_RUNTIME_IMAGE = "py-2026.08";

const ARGS = z.object({
  /** The program. Reads inputs from `in/`, writes outputs under `out/files/`, may append
   * event lines to `out/emits.jsonl` (returned to the model, not published — the model emits). */
  code: z.string().min(1).max(200_000),
  /** Asset paths to expose to the program under `in/<basename>`. */
  inputs: z.array(z.string().min(1)).max(50).default([]),
  wall_clock_ms: z.number().int().positive().max(600_000).optional(),
});

/** Used once, so inlined rather than given a module: the extension table for output mime. */
function mimeFor(relPath: string): string {
  const ext = path.posix.extname(relPath).toLowerCase();
  const table: Record<string, string> = {
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".csv": "text/csv",
    ".json": "application/json",
    ".parquet": "application/vnd.apache.parquet",
    ".png": "image/png",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".html": "text/html",
    ".tex": "application/x-tex",
  };
  return table[ext] ?? "application/octet-stream";
}

const TAIL = 4_000;
const tail = (s: string): string => (s.length > TAIL ? `…${s.slice(-TAIL)}` : s);

export type PythonToolDeps = {
  assets: AssetToolDeps;
  /** Absent = not configured; the tool reports that and does nothing. */
  pyrun?: PyrunClient | undefined;
  /** `limits_json.python.wall_clock_ms` — the task-level cap a call may only tighten. */
  maxWallClockMs?: number | undefined;
};

const PYRUNNER_NOT_CONFIGURED = "python.run is not available: the engine has no PYRUNNER_URL configured";

export function buildPythonTool(deps: PythonToolDeps): AgentTool {
  const packages = PYTHON_RUNTIME_MANIFEST[PYTHON_RUNTIME_IMAGE] ?? [];
  return {
    name: "python.run",
    description:
      `Run a Python 3 program in the compute sandbox (no network). Available packages: ${packages.join(", ")}. ` +
      "Input assets you name in `inputs` appear under in/<basename>. Every file the program writes under out/files/ " +
      "becomes an asset at that relative path (subject to this task's write grants) and its asset ref is returned — " +
      "create subdirectories yourself (os.makedirs). " +
      "stdout/stderr come back with the result. Lines the program appends to out/emits.jsonl are returned as text " +
      "for you to act on — the program cannot emit events itself; call `emit` with the packets you decide on.",
    parameters: ARGS,
    async execute(args): Promise<ToolResult> {
      const parsed = ARGS.safeParse(args);
      if (!parsed.success) return { ok: false, error: `invalid arguments for "python.run": ${parsed.error.message}` };
      if (!deps.pyrun) return { ok: false, error: PYRUNNER_NOT_CONFIGURED };
      const { db, blobs, userId, taskId, runId } = deps.assets;

      // -- Inputs: resolved by the host, shipped as bytes under a bare filename. ----------
      const inputs: { filename: string; bytes: Buffer }[] = [];
      const byName = new Set<string>();
      for (const declared of parsed.data.inputs) {
        let normalized: string;
        try {
          normalized = normalizeAssetPath(userId, declared);
        } catch (err) {
          return { ok: false, error: err instanceof AppError ? err.message : String(err) };
        }
        const [row] = await db
          .select({ blobRef: assets.blobRef })
          .from(assets)
          .where(and(eq(assets.userId, userId), eq(assets.path, normalized)));
        if (!row) return { ok: false, error: `input asset not found: "${declared}"` };
        const filename = path.posix.basename(normalized);
        if (byName.has(filename)) return { ok: false, error: `two inputs share the filename "${filename}"` };
        byName.add(filename);
        inputs.push({ filename, bytes: await blobs.get(row.blobRef) });
      }

      const requested = parsed.data.wall_clock_ms;
      const cap = deps.maxWallClockMs;
      const wallClockMs = requested !== undefined && cap !== undefined ? Math.min(requested, cap) : (requested ?? cap);

      const result = await deps.pyrun.run({
        code: parsed.data.code,
        trigger: null,
        assets: inputs,
        sourceDateEpoch: Math.floor(Date.now() / 1000),
        ...(wallClockMs !== undefined ? { wallClockMs } : {}),
      });

      if (!result.ok) {
        switch (result.kind) {
          case "program_error":
            return { ok: false, error: `python exited ${result.exitCode}:\n${tail(result.stderr)}` };
          case "killed":
            return { ok: false, error: "the program was killed: wall clock exceeded" };
          case "output_cap":
            return { ok: false, error: `output cap exceeded: ${result.limit}` };
          case "unavailable":
            return { ok: false, error: `pyrunner unavailable: ${result.log}` };
        }
      }

      // -- Outputs: validate every path before writing any of them. ----------------------
      // A partial write followed by a rejection would leave half a deliverable in the store.
      const planned: { rel: string; normalized: string; bytes: Buffer }[] = [];
      const claimed = new Set<string>();
      for (const file of result.files) {
        let normalized: string;
        try {
          normalized = normalizeAssetPath(userId, file.path);
        } catch (err) {
          return {
            ok: false,
            error: `the program wrote an invalid output path "${file.path}": ${err instanceof AppError ? err.message : String(err)}`,
          };
        }
        if (claimed.has(normalized)) return { ok: false, error: `two outputs resolve to the same asset path "${normalized}"` };
        claimed.add(normalized);
        if (!(await checkWriteGrant(db, taskId, normalized))) {
          return { ok: false, error: `write outside this task's granted paths: "${normalized}"` };
        }
        planned.push({ rel: file.path, normalized, bytes: file.bytes });
      }

      const refs: AssetRef[] = [];
      for (const file of planned) {
        const written = await putVersion(deps.assets, { path: file.normalized, bytes: file.bytes, mime: mimeFor(file.rel) });
        if (!written.ok) return { ok: false, error: `asset write failed for "${file.normalized}": ${written.error}` };
        const value = written.value as { path: string; mime: string; sha256: string };
        const [row] = await db
          .select({ id: assets.id })
          .from(assets)
          .where(and(eq(assets.userId, userId), eq(assets.path, file.normalized)));
        refs.push({ asset_id: row!.id, path: value.path, mime: value.mime, sha256: value.sha256 });
      }

      return {
        ok: true,
        value: untrustedBlock("python.run", {
          run_id: runId,
          duration_ms: result.durationMs,
          stdout: tail(result.stdout),
          stderr: tail(result.stderr),
          files: refs,
          ...(result.emitsJsonl.trim() ? { emits_jsonl: tail(result.emitsJsonl) } : {}),
        }),
      };
    },
  };
}

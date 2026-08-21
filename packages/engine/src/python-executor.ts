import path from "node:path";
import {
  checkWriteGrant,
  normalizeAssetPath,
  putVersion,
  type AssetToolDeps,
} from "@tabductor/assets";
import type { BlobStore } from "@tabductor/browser/blob-store";
import { AppError, type AssetRef } from "@tabductor/core";
import { assets, type Db } from "@tabductor/db";
import type { Metrics } from "@tabductor/telemetry";
import { and, eq } from "drizzle-orm";
import { graphRuntimeSchema } from "./graph.js";
import type { RunHandle, RunResult, TaskExecutor } from "./executor.js";
import { userIdForTask } from "./queries.js";
import type { PyrunClient } from "./pyrun-client.js";

// Re-exported through this subpath so a caller wiring the executor gets the client with it.
export {
  createPyrunClient,
  type PyrunClient,
  type PyrunClientOptions,
  type PyrunJob,
  type PyrunOutcome,
} from "./pyrun-client.js";
import { z } from "zod";

/**
 * `(asset, python)` — the executor for a task whose body is an authored Python program.
 *
 * The shape of the thing is: resolve declared inputs, hand the program to `apps/pyrunner`, and
 * then do every privileged act on its behalf, host-side — write its files into the asset store,
 * publish its emits through `RunHandle.emit`. The program itself calls nothing. That is why
 * `(asset, python)`'s tool registry is empty rather than filtered, and it is what keeps a
 * compute mode on the kind that owns `mcp.*` from reopening the exfiltration chain: the chain
 * is severed by the absence of a channel, not by a rule about which names are in a list.
 *
 * **Everything pyrunner returns is untrusted input.** Not because the program is hostile —
 * self-hosted, it is the operator's own code — but because this process is the one holding the
 * asset store's write capability, and a filename is a filename whatever wrote it. Paths are
 * normalized and grant-checked here, before any byte is written.
 */

export type PythonExecutorDeps = {
  db: Db;
  blobs: BlobStore;
  pyrun: PyrunClient;
  metrics?: Metrics;
};

/** One emitted event, as a line of `out/emits.jsonl`. */
const EMIT_LINE = z.object({
  type: z.string().min(1),
  packet: z.unknown(),
  /** Parsed but not yet honoured — the dedupe claim lives in `packages/agent`'s `makeEmitFn`,
   * which engine cannot import. Reserved so a program written against it stays valid. */
  dedupe_key: z.string().min(1).optional(),
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
  };
  return table[ext] ?? "application/octet-stream";
}

/**
 * Replaces `{"$asset": "<relative output path>"}` with the real ref.
 *
 * The program cannot know an `asset_id`: it is minted host-side by `putVersion`, after the
 * program has already written `emits.jsonl`, and there is no channel for it to ask. So it names
 * an output by the path it wrote, and this resolves it. An unresolvable placeholder fails the
 * run rather than surviving into a packet — ajv would happily accept the literal object against
 * a loose schema and publish an event pointing at nothing.
 */
function substituteAssetRefs(value: unknown, refs: Map<string, AssetRef>, seen: string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => substituteAssetRefs(v, refs, seen));
  if (value === null || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === "$asset" && typeof record.$asset === "string") {
    const ref = refs.get(record.$asset);
    if (!ref) {
      seen.push(record.$asset);
      return value;
    }
    return ref;
  }
  return Object.fromEntries(keys.map((k) => [k, substituteAssetRefs(record[k], refs, seen)]));
}

function permanent(error: string): RunResult {
  return { ok: false, error, permanent: true };
}

export function createPythonExecutor(deps: PythonExecutorDeps): TaskExecutor {
  return {
    async execute(handle: RunHandle): Promise<RunResult> {
      const started = Date.now();
      let outcome: "ok" | "program_error" | "killed" | "output_cap" | "write_error" | "unavailable" = "ok";
      try {
        const { task } = handle;
        // Both are publish-gate invariants (`checkGraph`). A run that sees them violated is
        // looking at a hand-edited row, and a retry would see the same one.
        if (!task.codeSource) return permanent("task has mode=python but no code_source");
        const runtime = graphRuntimeSchema.safeParse(task.runtimeJson);
        if (!runtime.success) {
          return permanent(`task has mode=python but an unreadable runtime_json: ${runtime.error.message}`);
        }
        if (runtime.data.inputs.tables.length > 0) {
          return permanent("runtime.inputs.tables is not wired yet");
        }

        const userId = await userIdForTask(deps.db, task.workflowVersionId);

        // Resolve declared inputs. The program opens them by bare filename, so a collision
        // between two declared paths is an error rather than a silent shadowing.
        const inputs: { filename: string; bytes: Buffer }[] = [];
        const byName = new Set<string>();
        for (const declared of runtime.data.inputs.assets) {
          let normalized: string;
          try {
            normalized = normalizeAssetPath(userId, declared);
          } catch (err) {
            return permanent(err instanceof AppError ? err.message : String(err));
          }
          const [row] = await deps.db
            .select({ blobRef: assets.blobRef })
            .from(assets)
            .where(and(eq(assets.userId, userId), eq(assets.path, normalized)));
          if (!row) return permanent(`declared input asset not found: "${declared}"`);
          const filename = path.posix.basename(normalized);
          if (byName.has(filename)) {
            return permanent(`two declared inputs share the filename "${filename}"`);
          }
          byName.add(filename);
          inputs.push({ filename, bytes: await deps.blobs.get(row.blobRef) });
        }

        const limits = task.limitsJson as Record<string, unknown> | null;
        const pythonLimits = limits?.python as Record<string, unknown> | undefined;
        const wallClockMs =
          typeof pythonLimits?.wall_clock_ms === "number" && pythonLimits.wall_clock_ms > 0
            ? pythonLimits.wall_clock_ms
            : undefined;

        const result = await deps.pyrun.run({
          code: task.codeSource,
          trigger: handle.trigger?.packet ?? null,
          assets: inputs,
          sourceDateEpoch: Math.floor((handle.trigger?.occurredAt ?? new Date()).getTime() / 1000),
          wallClockMs,
        });

        if (!result.ok) {
          outcome = result.kind;
          switch (result.kind) {
            case "program_error":
              // Retryable: a program that failed on a shape mismatch is correctable, and the
              // retry policy is what gives an author (or S8's compiler) the chance.
              return { ok: false, error: `python exited ${result.exitCode}: ${result.stderr.slice(-2_000)}` };
            case "killed":
              deps.metrics?.pyrunKills.add({ reason: result.reason });
              // Permanent: a job that ran out of wall clock will run out again.
              return permanent("pyrunner killed the job: wall clock");
            case "output_cap":
              return permanent(`output cap exceeded: ${result.limit}`);
            case "unavailable":
              // Infrastructure, not a program defect — retry.
              return { ok: false, error: `pyrunner unavailable: ${result.log}` };
          }
        }

        // -- Validate every output before writing any of them. -------------------------
        // A partial write followed by a rejection leaves half a deliverable in the store
        // under a `report.ready` that was never emitted.
        const planned: { rel: string; normalized: string; bytes: Buffer }[] = [];
        const claimed = new Set<string>();
        for (const file of result.files) {
          let normalized: string;
          try {
            normalized = normalizeAssetPath(userId, file.path);
          } catch (err) {
            outcome = "write_error";
            return permanent(
              `pyrunner returned an invalid output path "${file.path}": ${
                err instanceof AppError ? err.message : String(err)
              }`,
            );
          }
          if (claimed.has(normalized)) {
            outcome = "write_error";
            return permanent(`two outputs resolve to the same asset path "${normalized}"`);
          }
          claimed.add(normalized);
          if (!(await checkWriteGrant(deps.db, task.id, normalized))) {
            outcome = "write_error";
            return permanent(`write outside this task's granted paths: "${normalized}"`);
          }
          planned.push({ rel: file.path, normalized, bytes: file.bytes });
        }

        const assetDeps: AssetToolDeps = {
          db: deps.db,
          blobs: deps.blobs,
          userId,
          taskId: task.id,
          runId: handle.run.id,
          metrics: deps.metrics,
        };
        const refs = new Map<string, AssetRef>();
        let totalBytes = 0;
        for (const file of planned) {
          const written = await putVersion(assetDeps, {
            path: file.normalized,
            bytes: file.bytes,
            mime: mimeFor(file.rel),
          });
          if (!written.ok) {
            outcome = "write_error";
            return { ok: false, error: `asset write failed for "${file.normalized}": ${written.error}` };
          }
          const value = written.value as { path: string; mime: string; sha256: string };
          const [row] = await deps.db
            .select({ id: assets.id })
            .from(assets)
            .where(and(eq(assets.userId, userId), eq(assets.path, file.normalized)));
          refs.set(file.rel, {
            asset_id: row!.id,
            path: value.path,
            mime: value.mime,
            sha256: value.sha256,
          });
          totalBytes += file.bytes.byteLength;
        }
        deps.metrics?.pyrunOutputBytes.record(totalBytes);

        // -- Emits, published host-side through the same gate every other executor uses. --
        const lines = result.emitsJsonl.split("\n").filter((line) => line.trim() !== "");
        for (const [index, line] of lines.entries()) {
          let parsedLine: unknown;
          try {
            parsedLine = JSON.parse(line);
          } catch (err) {
            return { ok: false, error: `malformed emits.jsonl line ${index + 1}: ${String(err)}` };
          }
          const emit = EMIT_LINE.safeParse(parsedLine);
          if (!emit.success) {
            return { ok: false, error: `malformed emits.jsonl line ${index + 1}: ${emit.error.message}` };
          }
          const unresolved: string[] = [];
          const packet = substituteAssetRefs(emit.data.packet, refs, unresolved);
          if (unresolved.length > 0) {
            return {
              ok: false,
              error: `emits.jsonl line ${index + 1} references outputs this job did not produce: ${unresolved.join(", ")}`,
            };
          }
          // `handle.emit` applies the compiled packet schema, the `task_emits` declaration
          // gate, the loop budget, dedupe and the outbox — none of which the program touched.
          await handle.emit(emit.data.type, packet);
        }

        return { ok: true };
      } catch (err) {
        outcome = outcome === "ok" ? "write_error" : outcome;
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      } finally {
        deps.metrics?.pyrunJobs.add({ outcome });
        deps.metrics?.pyrunDuration.record((Date.now() - started) / 1000, { outcome });
      }
    },
  };
}

import { newId } from "@tabductor/core";
import { artifacts, traceEntries, actionSummaries, type Db, type TraceKind } from "@tabductor/db";
import { eq, sql } from "drizzle-orm";
import type { BlobStore } from "./blob-store.js";

/**
 * The trace recorder: the append-only writer behind every assertion the system tests make
 * (§17.1) and every input the Phase 6 compiler reads. Buffered, because a run emits a
 * navigation, a handful of actions and a screenshot in a few hundred milliseconds and one
 * round trip each would put the database in the middle of the browser's critical path.
 */

/**
 * Per-task storage opt-outs (`limits_json.storage`, §14). Absent means on: a user who has
 * expressed no preference gets a debuggable run.
 *
 * Evaluated at *write* time. Writing a category the user turned off and deleting it later
 * is the same as not honouring the setting — the bytes existed, and a backup or a replica
 * has them.
 */
export type StorageFlags = {
  navigations?: boolean;
  actions?: boolean;
  network?: boolean;
  screenshots?: boolean;
  llm?: boolean;
};

/** A blob to offload; `kind` is both the artifact kind and its storage category. */
export type BlobInput = { kind: keyof StorageFlags; bytes: Buffer; mime: string };

export type TraceRecorder = {
  record: (
    kind: TraceKind,
    payload: Record<string, unknown>,
    blob?: BlobInput,
  ) => Promise<void>;
  flush: () => Promise<void>;
  close: () => Promise<void>;
};

/**
 * Which flag governs which entry kind. `policy_denied` is absent on purpose: a denial is a
 * security signal, not run exhaust, and a storage setting that could switch it off would be
 * a setting that hides the evidence of the thing it was set to prevent.
 */
const CATEGORY: Partial<Record<TraceKind, keyof StorageFlags>> = {
  navigation: "navigations",
  action: "actions",
  network: "network",
  llm: "llm",
};

const enabled = (flags: StorageFlags, category: keyof StorageFlags | undefined): boolean =>
  category === undefined || flags[category] !== false;

/** Flush threshold — a long run must not hold its whole trace in memory. */
const BUFFER_LIMIT = 64;

type PendingEntry = {
  runId: string;
  seq: number;
  kind: TraceKind;
  payloadJson: Record<string, unknown>;
  blobRef: string | null;
  createdAt: Date;
};

type PendingArtifact = { id: string; runId: string; kind: string; blobRef: string; meta: object };

export function createTraceRecorder(
  db: Db,
  blobs: BlobStore,
  runId: string,
  storageFlags: StorageFlags = {},
  options: { flushIntervalMs?: number; onFlushError?: (error: unknown) => void } = {},
): TraceRecorder {
  const flushIntervalMs = options.flushIntervalMs ?? 1000;
  if (!Number.isSafeInteger(flushIntervalMs) || flushIntervalMs < 1) throw new Error("trace flush interval must be a positive integer");
  let seq = 0;
  // Resuming a durable human wait reuses its run. Continue its trace instead of silently
  // discarding new entries against the existing (run_id, seq) primary key.
  let sequenceBase: Promise<number> | undefined;
  let entries: PendingEntry[] = [];
  let pendingArtifacts: PendingArtifact[] = [];
  // Serializes flushes: two overlapping inserts of the same buffer would duplicate rows,
  // and the (run_id, seq) primary key would turn that into a run-killing error.
  let inFlight: Promise<void> = Promise.resolve();
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const recording = new Set<Promise<void>>();

  const flush = async (): Promise<void> => {
    const run = inFlight.then(async () => {
      const batch = entries;
      const batchArtifacts = pendingArtifacts;
      if (batch.length === 0 && batchArtifacts.length === 0) return;
      entries = [];
      pendingArtifacts = [];
      try {
        await db.transaction(async (trx) => {
          // A lost commit response may retry an already-persisted batch. Both keys are
          // stable, so retrying trace persistence cannot duplicate entries or artifacts.
          if (batch.length > 0) await trx.insert(traceEntries).values(batch).onConflictDoNothing();
          const python=batch.filter(entry=>entry.payloadJson.tool==="browser.python"&&typeof entry.payloadJson.code==="string"&&typeof entry.payloadJson.callId==="string");
          if(python.length){
            const owner=await trx.execute<{account_id:string}>(sql`select w.account_id from runs r join workflow_versions v on v.id=r.workflow_version_id join workflows w on w.id=v.workflow_id where r.id=${runId}`);
            if(owner.rows[0])await trx.insert(actionSummaries).values(python.map(entry=>({runId,callId:String(entry.payloadJson.callId),accountId:owner.rows[0]!.account_id,
              source:JSON.stringify({code:entry.payloadJson.code,ok:entry.payloadJson.ok,error:entry.payloadJson.error})}))).onConflictDoNothing();
          }
          if (batchArtifacts.length > 0) await trx.insert(artifacts).values(batchArtifacts).onConflictDoNothing();
        });
      } catch (error) {
        entries = [...batch, ...entries];
        pendingArtifacts = [...batchArtifacts, ...pendingArtifacts];
        throw error;
      }
    });
    inFlight = run.catch(() => undefined);
    return run;
  };

  return {
    record(kind, payload, blob) {
      if (closed) return Promise.reject(new Error("trace recorder is closed"));
      if (!enabled(storageFlags, CATEGORY[kind])) return Promise.resolve();
      const entrySeq = seq++;
      sequenceBase ??= db.select({ next: sql<number>`coalesce(max(${traceEntries.seq}), -1) + 1` }).from(traceEntries)
        .where(eq(traceEntries.runId, runId)).then(rows => Number(rows[0]!.next));
      const createdAt = new Date();
      if (!timer) {
        timer = setInterval(() => {
          void flush().catch((error: unknown) => options.onFlushError?.(error));
        }, flushIntervalMs);
        timer.unref();
      }

      const pending = (async () => {
        let blobRef: string | null = null;
        if (blob && enabled(storageFlags, blob.kind)) {
          blobRef = await blobs.put(blob.bytes, { mime: blob.mime });
          pendingArtifacts.push({
            id: newId("artifact"),
            runId,
            kind: blob.kind,
            blobRef,
            meta: { mime: blob.mime, bytes: blob.bytes.byteLength },
          });
        }

        entries.push({ runId, seq: (await sequenceBase!) + entrySeq, kind, payloadJson: payload, blobRef, createdAt });
        if (entries.length >= BUFFER_LIMIT) await flush();
      })();
      const tracked = pending.finally(() => recording.delete(tracked));
      recording.add(tracked);
      return tracked;
    },

    flush,

    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      const pending = await Promise.allSettled([...recording]);
      await flush();
      const failed = pending.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
  };
}

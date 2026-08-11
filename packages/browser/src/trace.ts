import { newId } from "@tabductor/core";
import { artifacts, traceEntries, type Db, type TraceKind } from "@tabductor/db";
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
};

type PendingArtifact = { id: string; runId: string; kind: string; blobRef: string; meta: object };

export function createTraceRecorder(
  db: Db,
  blobs: BlobStore,
  runId: string,
  storageFlags: StorageFlags = {},
): TraceRecorder {
  let seq = 0;
  let entries: PendingEntry[] = [];
  let pendingArtifacts: PendingArtifact[] = [];
  // Serializes flushes: two overlapping inserts of the same buffer would duplicate rows,
  // and the (run_id, seq) primary key would turn that into a run-killing error.
  let inFlight: Promise<void> = Promise.resolve();

  const flush = async (): Promise<void> => {
    const run = inFlight.then(async () => {
      const batch = entries;
      const batchArtifacts = pendingArtifacts;
      if (batch.length === 0 && batchArtifacts.length === 0) return;
      entries = [];
      pendingArtifacts = [];
      await db.transaction(async (trx) => {
        if (batch.length > 0) await trx.insert(traceEntries).values(batch);
        if (batchArtifacts.length > 0) await trx.insert(artifacts).values(batchArtifacts);
      });
    });
    inFlight = run.catch(() => undefined);
    return run;
  };

  return {
    async record(kind, payload, blob) {
      if (!enabled(storageFlags, CATEGORY[kind])) return;

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

      entries.push({ runId, seq: seq++, kind, payloadJson: payload, blobRef });
      if (entries.length >= BUFFER_LIMIT) await flush();
    },

    flush,

    async close() {
      await flush();
    },
  };
}

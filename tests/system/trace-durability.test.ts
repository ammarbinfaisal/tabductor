import { afterEach, beforeEach, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { traceEntries } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { createTraceRecorder, type TraceRecorder } from "@tabductor/browser";
import { triggerTask } from "@tabductor/engine";
import { seedWorkflow } from "@tabductor/engine/testing";
import { waitFor } from "./engine-support.js";

let handle: MigratedTestDb;
let recorder: TraceRecorder;
let runId: string;
beforeEach(async () => {
  handle = await createMigratedTestDb();
  const wf = await seedWorkflow(handle.db, { tasks: { Work: {} } });
  runId = (await triggerTask(handle.db, { taskId: wf.taskIds.Work! })).dispatched!.runId;
});
afterEach(async () => { await recorder?.close(); await handle?.close(); });
const blobs = { put: async () => "unused", get: async () => Buffer.alloc(0) };
const rows = () => handle.db.select().from(traceEntries).where(eq(traceEntries.runId, runId)).orderBy(asc(traceEntries.seq));

it("flushes sparse activity on the interval before close", async () => {
  recorder = createTraceRecorder(handle.db, blobs, runId, {}, { flushIntervalMs: 10 });
  const before = new Date();
  await recorder.record("action", { action: "first" });
  const after = new Date();
  const saved = await waitFor("periodic trace flush", async () => {
    const found = await rows();
    return found.length ? found : false;
  });
  expect(saved[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  expect(saved[0]!.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
  await recorder.close();
  await expect(recorder.record("action", { action: "after close" })).rejects.toThrow("closed");
});

it("retains a failed batch and retries it ahead of newer records without duplicates", async () => {
  recorder = createTraceRecorder(handle.db, blobs, runId, {}, { flushIntervalMs: 60_000 });
  await handle.db.execute(sql`create sequence fail_trace_once`);
  await handle.db.execute(sql`create function fail_trace() returns trigger language plpgsql as $$
    begin if nextval('fail_trace_once') = 1 then raise exception 'transient trace failure'; end if; return new; end $$`);
  await handle.db.execute(sql`create trigger fail_trace before insert on trace_entries for each row execute function fail_trace()`);
  await recorder.record("action", { action: "first" });
  await expect(recorder.flush()).rejects.toMatchObject({ cause: { message: "transient trace failure" } });
  expect(await rows()).toHaveLength(0);
  await recorder.record("action", { action: "second" });
  await Promise.all([recorder.flush(), recorder.flush()]);
  expect((await rows()).map((row) => [row.seq, row.payloadJson])).toEqual([
    [0, { action: "first" }], [1, { action: "second" }],
  ]);
});

it("close waits for a blob upload already in flight", async () => {
  let complete!: (ref: string) => void;
  const uploaded = new Promise<string>((resolve) => { complete = resolve; });
  recorder = createTraceRecorder(handle.db, { ...blobs, put: () => uploaded }, runId);
  const recording = recorder.record("action", { action: "screenshot" }, { kind: "screenshots", bytes: Buffer.from("image"), mime: "image/png" });
  const closing = recorder.close();
  complete("sha256:test");
  await Promise.all([recording, closing]);
  expect((await rows())[0]!.blobRef).toBe("sha256:test");
  expect(await handle.db.query.artifacts.findMany()).toHaveLength(1);
});

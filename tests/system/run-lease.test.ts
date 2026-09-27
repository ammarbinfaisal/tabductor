import { afterEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { runs, taskState } from "@tabductor/db";
import { assertRunLease, cancelRun, type RunHandle } from "@tabductor/engine";
import { seedWorkflow } from "@tabductor/engine/testing";
import { startRig, trigger, waitFor, eventsOfType, type Rig } from "./engine-support.js";

let rig: Rig;
let release: (() => void) | undefined;
afterEach(async () => { release?.(); await rig?.stop(); });

it.each(["cancel", "generation"])("rejects stale emits and staged writes after %s", async (cause) => {
  let handle: RunHandle | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  rig = await startRig({ heartbeatIntervalMs: 20, executors: {
    "browser:stub": { execute: async (input) => { handle = input; await held; return { ok: true }; } },
  } });
  const wf = await seedWorkflow(rig.handle.db, {
    tasks: { Start: {}, Work: { emits: { "work.done": { type: "object" } } } },
    edges: [["Start", "work.requested", "Work"]],
  });
  await trigger(rig, wf.taskIds.Start!, "work.requested");
  const active = await waitFor("executor to start", async () => handle);
  if (cause === "cancel") await cancelRun(rig.handle.db, active.run.id);
  else await rig.handle.db.update(runs).set({ leaseGeneration: sql`${runs.leaseGeneration} + 1` })
    .where(eq(runs.id, active.run.id));
  const write = vi.fn(async () => {});
  await expect(active.emit("work.done", {}, { dedupeKey: "record", withTx: write })).rejects.toThrow("run ownership ended");
  expect(write).not.toHaveBeenCalled();
  expect(await eventsOfType(rig, "work.done")).toHaveLength(0);
  expect(await rig.handle.db.select().from(taskState)).toHaveLength(0);
  await expect(rig.handle.db.transaction((trx) => assertRunLease(trx, active.run.id, active.run.leaseGeneration)))
    .rejects.toThrow("run ownership ended");
  await waitFor("executor abort", async () => active.signal.aborted);
});

it("rolls back emit claims and writes together when publication fails", async () => {
  let handle: RunHandle | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  rig = await startRig({ executors: {
    "browser:stub": { execute: async (input) => { handle = input; await held; return { ok: true }; } },
  } });
  const wf = await seedWorkflow(rig.handle.db, {
    tasks: { Start: {}, Work: { emits: { "work.done": { type: "object" } } } },
    edges: [["Start", "work.requested", "Work"]],
  });
  await trigger(rig, wf.taskIds.Start!, "work.requested");
  const active = await waitFor("executor to start", async () => handle);
  await expect(active.emit("work.done", {}, { dedupeKey: "record", withTx: async (trx) => {
    await trx.insert(taskState).values({ taskId: active.task.id, key: "staged", value: {} });
    throw new Error("injected commit failure");
  } })).rejects.toThrow("injected commit failure");
  expect(await rig.handle.db.select().from(taskState)).toHaveLength(0);
  expect(await active.emit("work.done", {}, { dedupeKey: "record" })).not.toBeNull();
  expect(await active.emit("work.done", {}, { dedupeKey: "record" })).toBeNull();
});

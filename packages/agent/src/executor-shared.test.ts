import { expect, it } from "vitest";
import type { Db, EventRow } from "@tabductor/db";
import { createWriteStager } from "@tabductor/store";
import { makeEmitFn } from "./executor-shared.js";

it("preserves staged writes in order when a rejected emit is corrected", async () => {
  const stager = createWriteStager();
  const applied: string[] = [];
  const db = {} as Db; // writes below are in-memory callbacks; no database access
  let calls = 0;
  const event: EventRow = { eventId: "event", type: "item.ready", executionId: null, sourceTaskId: null,
    sourceRunId: null, causationId: null, packet: {}, traceparent: null, occurredAt: new Date() };
  const emit = makeEmitFn({
    db, taskId: "task", trace: { record: async () => {}, flush: async () => {}, close: async () => {} },
    handleEmit: async (_type, _packet, opts) => {
      if (++calls === 1) throw new Error("packet validation failed");
      await opts?.withTx?.(db);
      return event;
    },
    drainPendingWrites: stager.drain, restorePendingWrites: stager.restore,
    wrapPendingWrites: (writes) => async (trx) => { for (const write of writes) await write(trx); },
  });
  stager.stage(async () => { applied.push("first"); });
  expect(await emit("item.ready", {}, "item")).toMatchObject({ outcome: "rejected" });
  expect(stager.pending()).toBe(1);
  stager.stage(async () => { applied.push("second"); });
  expect(await emit("item.ready", { corrected: true }, "item")).toMatchObject({ outcome: "published" });
  expect(applied).toEqual(["first", "second"]);
  expect(stager.pending()).toBe(0);
});

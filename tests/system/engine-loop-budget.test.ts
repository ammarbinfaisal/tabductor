import { afterEach, expect, it } from "vitest";
import { LOOP_BUDGET_EXCEEDED, seedWorkflow } from "@tabductor/engine";
import { allRuns, eventsOfType, startRig, trigger, waitForQuiet, type Rig } from "./engine-support.js";

let rig: Rig;

afterEach(async () => {
  await rig?.stop();
});

/**
 * Cycles are a feature (polling loops, retries) — the budget is what keeps them from
 * burning the user's tokens and browser forever (§5). A→B→A ping-pongs until the causation
 * chain hits `max_hops`, at which point the next dispatch is refused and announced.
 */
it("stops a cycle at max_hops and announces the budget exhaustion", async () => {
  rig = await startRig();
  const wf = await seedWorkflow(rig.handle.db, {
    maxHops: 6,
    tasks: {
      Start: {},
      A: { stub: { emits: [{ type: "a.ping", packet: {} }] } },
      B: { stub: { emits: [{ type: "b.pong", packet: {} }] } },
    },
    edges: [
      ["Start", "cycle.start", "A"],
      ["A", "a.ping", "B"],
      ["B", "b.pong", "A"],
    ],
  });

  await trigger(rig, wf.taskIds.Start!, "cycle.start");
  await waitForQuiet(rig);

  // Exactly six runs — the budget, not one more.
  const created = await allRuns(rig);
  expect(created).toHaveLength(6);
  expect(created.every((r) => r.status === "succeeded")).toBe(true);

  // The 7th dispatch is refused and surfaces as a subscribable system event.
  const exceeded = await eventsOfType(rig, LOOP_BUDGET_EXCEEDED);
  expect(exceeded).toHaveLength(1);
  expect(exceeded[0]!.packet).toMatchObject({ workflowId: wf.workflowId, maxHops: 6 });

  // Settling once more proves the loop is genuinely dead, not merely slow.
  await waitForQuiet(rig);
  expect(await allRuns(rig)).toHaveLength(6);
});

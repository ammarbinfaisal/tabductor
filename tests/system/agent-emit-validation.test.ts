import { afterEach, expect, it } from "vitest";
import { seedWorkflow } from "@tabductor/engine";
import { eventsOfType, runsForTask, trigger, waitFor, waitForQuiet } from "./engine-support.js";
import { startAgentRig, waitForTraceRows, type AgentRig } from "./agent-support.js";

/**
 * S4b spec §6, third bullet: one malformed `emit` (missing a required field), the ajv error
 * comes back as the TOOL RESULT (not a run failure), the model's corrected retry succeeds —
 * run succeeds, exactly one downstream trigger. Fixture:
 * `fixtures/transcripts/emit-validation-retry.jsonl` (hand-authored).
 */

let rig: AgentRig | undefined;

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

it("a malformed emit surfaces as a tool error and retries within budget; run succeeds, one trigger", async () => {
  rig = await startAgentRig({ fixtureFor: () => "emit-validation-retry.jsonl" });

  const wf = await seedWorkflow(rig.handle.db, {
    tasks: {
      Start: {},
      Scrape: {
        mode: "ai",
        prompt: "Emit tweet.detected for the first tweet.",
        emits: ["tweet.detected"],
        consumes: ["work.requested"],
      },
    },
    events: {
      "tweet.detected": {
        description: "A tweet the agent noticed.",
        schema: {
          type: "object",
          properties: { text: { type: "string" }, url: { type: "string" } },
          required: ["text", "url"],
          additionalProperties: false,
        },
      },
    },
  });

  await trigger(rig, wf.taskIds.Start!, "work.requested");
  const run = await waitFor("Scrape's run to succeed", async () => {
    const [row] = await runsForTask(rig!, wf.taskIds.Scrape!);
    return row?.status === "succeeded" ? row : false;
  });
  await waitForQuiet(rig);

  const attempts = await runsForTask(rig, wf.taskIds.Scrape!);
  expect(attempts).toHaveLength(1); // no retry at the run level — the loop corrected itself

  const emitted = await eventsOfType(rig, "tweet.detected");
  expect(emitted).toHaveLength(1);
  expect(emitted[0]!.packet).toEqual({ text: "first tweet", url: "/fake-tweets/status/t1" });

  const rows = await waitForTraceRows(rig, run.id, (r) => r.filter((x) => (x.payloadJson as { action?: string }).action === "emit").length >= 2);
  const emitRows = rows.filter((r) => (r.payloadJson as { action?: string }).action === "emit");
  expect(emitRows).toHaveLength(2);
  expect(emitRows[0]).toMatchObject({ payloadJson: expect.objectContaining({ ok: false }) });
  expect((emitRows[0]!.payloadJson as { error: string }).error).toContain("packet failed schema");
  expect(emitRows[1]).toMatchObject({ payloadJson: expect.objectContaining({ ok: true }) });
});

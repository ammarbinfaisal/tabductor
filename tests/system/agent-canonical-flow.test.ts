import { afterEach, expect, it } from "vitest";
import { seedWorkflow } from "@tabductor/engine";
import { eventsOfType, runsForTask, trigger, waitFor, waitForQuiet } from "./engine-support.js";
import { startAgentRig, waitForTraceRows, type AgentRig } from "./agent-support.js";

/**
 * S4b's canonical replay flow (spec §6, first bullet): goto fake-tweets, extract each tweet's
 * permalink, `emit tweet.detected` × 3 with dedupe keys, a downstream `StubExecutor` task
 * receiving all three packets. Fixture: `fixtures/transcripts/canonical-fake-tweets.jsonl`,
 * hand-authored (see `docs/subphases/S4b-agent-loop.md`'s "Built" note for why).
 */

let rig: AgentRig | undefined;

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

it("replays goto -> extract -> emit tweet.detected x3 with dedupe keys; downstream stub sees all three", async () => {
  rig = await startAgentRig({ fixtureFor: () => "canonical-fake-tweets.jsonl" });

  const wf = await seedWorkflow(rig.handle.db, {
    tasks: {
      Start: {},
      Scrape: {
        mode: "ai",
        prompt: "Visit fake-tweets, and for each tweet emit tweet.detected with its text and permalink url.",
        emits: ["tweet.detected"],
        consumes: ["work.requested"],
      },
      Collect: { mode: "stub", consumes: ["tweet.detected"] },
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

  const scrapeRun = await waitFor("Scrape's run to succeed", async () => {
    const [row] = await runsForTask(rig!, wf.taskIds.Scrape!);
    return row?.status === "succeeded" ? row : false;
  });
  await waitForQuiet(rig);

  const emitted = await eventsOfType(rig, "tweet.detected");
  expect(emitted).toHaveLength(3);
  const packets = emitted.map((e) => e.packet as { text: string; url: string });
  expect(packets.map((p) => p.text).sort()).toEqual(["first tweet", "second tweet", "third tweet"]);
  expect(new Set(packets.map((p) => p.url)).size).toBe(3); // distinct dedupe keys, one per tweet

  // The downstream stub task ran once per event — "receives all three packets".
  const collectRuns = await runsForTask(rig, wf.taskIds.Collect!);
  expect(collectRuns).toHaveLength(3);
  expect(collectRuns.every((r) => r.status === "succeeded")).toBe(true);

  const rows = await waitForTraceRows(rig, scrapeRun.id, (r) => r.some((x) => x.kind === "llm"));
  const llmRows = rows.filter((r) => r.kind === "llm");
  expect(llmRows.length).toBeGreaterThan(0);
  for (const row of llmRows) {
    const payload = row.payloadJson as { prompt_hash?: string; usage?: unknown };
    expect(typeof payload.prompt_hash).toBe("string");
    expect(payload.usage).toBeDefined();
  }

  // Resolved locators land in the trace on the actions that used them (S4a §8) — never the
  // bare anchor id the model itself used, whichever element it chose to extract from (this
  // fixture is a real recording, §S4b's "Built" note — the model is free to scope its
  // extract calls to whichever anchor it perceived, article or permalink alike).
  const extractRows = rows.filter((r) => (r.payloadJson as { action?: string }).action === "queryAll");
  expect(extractRows.length).toBeGreaterThan(0);
  for (const row of extractRows) {
    const payload = row.payloadJson as { selector?: string };
    expect(payload.selector).toBeTruthy();
    expect(payload.selector).not.toMatch(/^e\d+$/);
  }
});

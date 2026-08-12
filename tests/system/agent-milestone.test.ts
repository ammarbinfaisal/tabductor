import { afterEach, expect, it } from "vitest";
import { seedWorkflow } from "@tabductor/engine";
import { eventsOfType, runsForTask, trigger, waitFor, waitForQuiet } from "./engine-support.js";
import { fakeGramSubmissionCount, startAgentRig, type AgentRig } from "./agent-support.js";

/**
 * S4b's first end-to-end milestone (spec §6, fifth bullet): fake-tweets (cron, agent) →
 * `tweet.detected` → second agent task posts to fake-gram; a scheduler re-fire re-runs the
 * first task and `emitIfNew` dedupe prevents any double-post — assert the fake-gram
 * submission count stays at one per tweet, not one per (tweet × fire).
 *
 * "Scheduler re-fire" is stood in for by publishing the same `cron.fire` event type twice
 * directly (`trigger()`) rather than waiting on a real cron tick — schedules are themselves
 * just another event source into this same dispatch path (techical_plan §7), so this
 * exercises exactly the dedupe property the milestone is about without adding wall-clock
 * flakiness to the suite.
 */

let rig: AgentRig | undefined;

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

it("cron -> agent -> tweet.detected -> agent posts to fake-gram; re-fire + emitIfNew dedupe -> exactly one post per tweet", async () => {
  rig = await startAgentRig({
    fixtureFor: (task) => (task.name === "Scrape" ? "milestone-scrape.jsonl" : "milestone-poster.jsonl"),
  });

  const wf = await seedWorkflow(rig.handle.db, {
    tasks: {
      Scrape: {
        mode: "ai",
        prompt: "On each fire, visit fake-tweets and emit tweet.detected for each tweet, deduped by url.",
        emits: ["tweet.detected"],
        consumes: ["cron.fire"],
      },
      Poster: {
        mode: "ai",
        prompt: "For each tweet.detected, post it to fake-gram.",
        consumes: ["tweet.detected"],
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

  // Fire 1: three tweets detected, three posts.
  await trigger(rig, wf.taskIds.Scrape!, "cron.fire");
  await waitFor("first Scrape run to succeed", async () => {
    const rows = await runsForTask(rig!, wf.taskIds.Scrape!);
    return rows.length === 1 && rows[0]!.status === "succeeded" ? rows[0] : false;
  });
  await waitForQuiet(rig);

  expect(await eventsOfType(rig, "tweet.detected")).toHaveLength(3);
  const posterRunsAfterFirst = await runsForTask(rig, wf.taskIds.Poster!);
  expect(posterRunsAfterFirst).toHaveLength(3);
  expect(posterRunsAfterFirst.every((r) => r.status === "succeeded")).toBe(true);
  expect(await fakeGramSubmissionCount(rig)).toBe(3);

  // Fire 2 ("scheduler re-fire"): same tweets, same dedupe keys — zero new emits, zero new posts.
  await trigger(rig, wf.taskIds.Scrape!, "cron.fire");
  await waitFor("second Scrape run to succeed", async () => {
    const rows = await runsForTask(rig!, wf.taskIds.Scrape!);
    return rows.length === 2 && rows.every((r) => r.status === "succeeded") ? rows : false;
  });
  await waitForQuiet(rig);

  expect(await eventsOfType(rig, "tweet.detected")).toHaveLength(3); // still 3, not 6
  expect(await runsForTask(rig, wf.taskIds.Poster!)).toHaveLength(3); // Poster never re-ran
  expect(await fakeGramSubmissionCount(rig)).toBe(3); // exactly one post per tweet
});

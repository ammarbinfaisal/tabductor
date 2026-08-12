import { createLlm, providerFromEnv } from "@tabductor/agent";
import { seedWorkflow } from "@tabductor/engine";
import { afterEach, describe, expect, it } from "vitest";
import { eventsOfType, runsForTask, trigger, waitFor, waitForQuiet } from "../system/engine-support.js";
import { startAgentRig, type AgentRig } from "../system/agent-support.js";

/**
 * S4b's live-eval suite (spec §6, last bullet): the canonical fake-tweets flow, `live` mode,
 * asserting OUTCOMES only — the model's actual path through the tool registry (how many
 * `page.extract` calls, in what order) is exactly what this suite must NOT assert on, because
 * it is not reproducible run to run the way a replay transcript is. This is the model-drift
 * alarm: if the outcome regresses, something about the tool surface or the prompt drifted out
 * from under a real model.
 *
 * Guarded on either key `providerFromEnv` accepts (S4a's two-provider deviation) — skipped
 * with no key set, which is the default in every environment this suite is not deliberately
 * run in (`pnpm test`/`pnpm test:system` never load this file at all; see
 * `vitest.live-eval.config.ts`).
 */

const selected = providerFromEnv(process.env);

describe.skipIf(!selected)("live-eval: fake-tweets", () => {
  let rig: AgentRig | undefined;

  afterEach(async () => {
    await rig?.stop();
    rig = undefined;
  });

  it("a live model reads fake-tweets and emits tweet.detected for each tweet, deduped by url", async () => {
    const { provider, apiKey } = selected!;
    rig = await startAgentRig({
      llmFor: ({ trace }) => createLlm("live", { provider, apiKey, trace }),
    });

    const wf = await seedWorkflow(rig.handle.db, {
      tasks: {
        Start: {},
        Scrape: {
          mode: "ai",
          prompt: [
            `Go to ${rig.fx.url}/fake-tweets and wait for the tweets to load.`,
            "For every tweet you find, call `emit` with type \"tweet.detected\" and a packet",
            "{ text, url } — `text` is the tweet's own text, `url` is the tweet's permalink",
            "(the href of its \"permalink\" link, read via page.extract). Use that same url as",
            "the emit's dedupeKey. After every tweet has been emitted, call `done`.",
          ].join(" "),
          emits: ["tweet.detected"],
          consumes: ["work.requested"],
        },
      },
      events: {
        "tweet.detected": {
          description: "A tweet the agent noticed: its text and its permalink url.",
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
    await waitFor(
      "Scrape's run to finish",
      async () => {
        const [row] = await runsForTask(rig!, wf.taskIds.Scrape!);
        return row && row.status !== "queued" && row.status !== "running" ? row : false;
      },
      90_000,
    );
    await waitForQuiet(rig, 90_000);

    const [run] = await runsForTask(rig, wf.taskIds.Scrape!);
    expect(run?.status).toBe("succeeded");

    const emitted = await eventsOfType(rig, "tweet.detected");
    expect(emitted.length).toBeGreaterThanOrEqual(3); // the fixture seeds exactly 3
    const texts = new Set(emitted.map((e) => (e.packet as { text: string }).text));
    for (const expected of ["first tweet", "second tweet", "third tweet"]) {
      expect(texts.has(expected)).toBe(true);
    }
    // Outcome, not sequence: every emitted packet has a non-empty, distinct url — the dedupe
    // key worked, however many turns the model took to get there.
    const urls = emitted.map((e) => (e.packet as { url: string }).url);
    expect(urls.every((u) => typeof u === "string" && u.length > 0)).toBe(true);
    expect(new Set(urls).size).toBe(urls.length);
  });
});

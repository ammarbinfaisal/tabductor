import { afterEach, expect, it } from "vitest";
import type { Llm, LlmRequest } from "@tabductor/agent";
import { seedWorkflow } from "@tabductor/engine";
import { eventsOfType, runsForTask, trigger, waitFor, waitForQuiet } from "./engine-support.js";
import { startAgentRig, waitForTraceRows, type AgentRig } from "./agent-support.js";

/**
 * S4b spec §6, second bullet: `network.list` then `network.read(response_body)` on the
 * timeline XHR — body content visible in the next LLM request, and the read traced.
 * Fixture: `fixtures/transcripts/network-tools.jsonl` (hand-authored).
 */

let rig: AgentRig | undefined;

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

it("network.list then network.read(response_body): the real body reaches the next request, and the read is traced", async () => {
  const seenRequests: LlmRequest[] = [];

  rig = await startAgentRig({
    fixtureFor: () => "network-tools.jsonl",
    wrapLlm: (llm): Llm => ({
      async complete(req) {
        seenRequests.push(req);
        return llm.complete(req);
      },
    }),
  });

  const wf = await seedWorkflow(rig.handle.db, {
    tasks: {
      Start: {},
      Scrape: {
        mode: "ai",
        prompt: "Read the timeline XHR's response body and emit timeline.read with the tweet count.",
        emits: ["timeline.read"],
        consumes: ["work.requested"],
      },
    },
    events: {
      "timeline.read": {
        description: "The timeline XHR body, summarized.",
        schema: { type: "object", properties: { tweetCount: { type: "number" } }, required: ["tweetCount"] },
      },
    },
  });

  await trigger(rig, wf.taskIds.Start!, "work.requested");
  const run = await waitFor("Scrape's run to succeed", async () => {
    const [row] = await runsForTask(rig!, wf.taskIds.Scrape!);
    return row?.status === "succeeded" ? row : false;
  });
  await waitForQuiet(rig);

  expect(await eventsOfType(rig, "timeline.read")).toHaveLength(1);

  // The turn *after* `network.read` carries the real response body — not a stand-in, not the
  // hand-authored transcript's own text, the actual bytes fake-tweets served this run.
  const afterRead = seenRequests.find((r) =>
    r.messages.some((m) => m.content.includes("first tweet") && m.content.includes("second tweet")),
  );
  expect(afterRead).toBeDefined();
  expect(afterRead!.messages.some((m) => m.content.includes("<<<UNTRUSTED_DATA"))).toBe(true);

  const rows = await waitForTraceRows(rig, run.id, (r) =>
    r.some((x) => (x.payloadJson as { action?: string }).action === "network.read"),
  );
  const readRow = rows.find((r) => (r.payloadJson as { action?: string }).action === "network.read")!;
  expect(readRow.payloadJson).toMatchObject({ index: 1, parts: ["response_body"], ok: true });
  const listRow = rows.find((r) => (r.payloadJson as { action?: string }).action === "network.list")!;
  expect(listRow.payloadJson).toMatchObject({ ok: true });

  // The tweet bodies never appear in the trace itself (§14: page/network content is opt-in,
  // never a default) — only the read's shape (index, parts, size) does.
  expect(JSON.stringify(rows)).not.toContain("first tweet");
});

import { afterEach, expect, it } from "vitest";
import type { Llm, LlmRequest } from "@tabductor/agent";
import { seedWorkflow, triggerTask, updateTask } from "@tabductor/engine";
import { runsForTask, waitFor, waitForQuiet } from "./engine-support.js";
import { insertFakeMcpServer, startMcpRig, waitForTraceRows, type McpRig } from "./mcp-support.js";

/**
 * S5c deliverable 5, `packages/mcp/src/client.ts`'s core contract — hand-authored transcripts
 * (`fixtures/transcripts/mcp-*.jsonl`), the same call this codebase's precedent doc
 * (`fixtures/transcripts/README.md`) makes for `emit-validation-retry.jsonl`/
 * `step-budget.jsonl`: each scenario needs an exact, reproducible tool-call sequence (call
 * `echo` exactly N times, block on `sleep` for longer than the configured timeout) that a live
 * model cannot reliably be prompted into without the prompt itself giving the answer away.
 *
 * All three scenarios share one seeded workflow shape — a single `(asset, ai)` task with one
 * configured MCP server (the testkit fake, `echo`/`imageStub`/`sleep`) — and differ only in
 * `limits_json.mcp` and which transcript replays.
 */

let rig: McpRig | undefined;

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

async function seedAssetTask(userId = "user_test") {
  const wf = await seedWorkflow(rig!.handle.db, {
    userId,
    tasks: { Asset: { kind: "asset", mode: "ai", prompt: "Call the fake MCP server." } },
  });
  await insertFakeMcpServer(rig!.handle, { userId });
  return wf;
}

it("calls mcp.fake.echo: the result reaches the next request wrapped in untrusted-data delimiters, traced, run succeeds", async () => {
  const seenRequests: LlmRequest[] = [];
  rig = await startMcpRig({
    fixtureFor: () => "mcp-echo.jsonl",
    wrapLlm: (llm): Llm => ({
      async complete(req) {
        seenRequests.push(req);
        return llm.complete(req);
      },
    }),
  });

  const wf = await seedAssetTask();
  await triggerTask(rig.handle.db, { taskId: wf.taskIds.Asset! });
  const run = await waitFor("Asset's run to succeed", async () => {
    const [row] = await runsForTask(rig!, wf.taskIds.Asset!);
    return row?.status === "succeeded" ? row : false;
  });
  await waitForQuiet(rig);

  // The echoed payload reaches the *next* LLM request, delimited as untrusted data — not a
  // stand-in string, the real `{echoed: {hello: "asset node"}}` the fake server's `echo` tool
  // actually returned this run. Two delimiter layers are present in the raw message text: the
  // loop's own "tool results" wrapper (unescaped, since it is the outermost `untrustedBlock`
  // call) and the inner `mcp.fake.echo` one, JSON-escaped inside it — checked for by
  // substring rather than exact quoting, since asserting the escaping is asserting
  // `JSON.stringify`'s behaviour, not this subphase's.
  const afterCall = seenRequests.find((r) => r.messages.some((m) => m.content.includes("<<<UNTRUSTED_DATA")));
  expect(afterCall).toBeDefined();
  const wrapped = afterCall!.messages.find((m) => m.content.includes("<<<UNTRUSTED_DATA"))!.content;
  expect(wrapped).toContain("mcp.fake.echo");
  expect(wrapped).toContain("asset node");

  const rows = await waitForTraceRows(rig, run.id, (r) =>
    r.some((x) => (x.payloadJson as { action?: string }).action === "mcp.call"),
  );
  const callRow = rows.find((r) => (r.payloadJson as { action?: string }).action === "mcp.call")!;
  expect(callRow.payloadJson).toMatchObject({ server: "fake", tool: "echo", ok: true, outcome: "ok" });
  expect(JSON.stringify(callRow.payloadJson)).toContain("asset node");
});

it("a transcript exceeding limits_json.mcp.max_calls fails the run with a typed budget error, trace shows the breach", async () => {
  rig = await startMcpRig({ fixtureFor: () => "mcp-budget.jsonl" });

  const wf = await seedAssetTask();
  await updateTask(rig.handle.db, { taskId: wf.taskIds.Asset!, limits: { mcp: { max_calls: 2 } } });

  await triggerTask(rig.handle.db, { taskId: wf.taskIds.Asset! });
  const run = await waitFor("Asset's run to fail", async () => {
    const [row] = await runsForTask(rig!, wf.taskIds.Asset!);
    return row?.status === "failed" ? row : false;
  });
  await waitForQuiet(rig);

  expect(run.error).toContain("exceeded its MCP call budget");

  const rows = await waitForTraceRows(rig, run.id, (r) =>
    r.some((x) => (x.payloadJson as { outcome?: string }).outcome === "budget_exceeded"),
  );
  const calls = rows.filter((r) => (r.payloadJson as { action?: string }).action === "mcp.call");
  // Two calls actually reached the server (the budget); the third is the breach itself, with
  // no server round trip behind it.
  expect(calls.filter((r) => (r.payloadJson as { outcome?: string }).outcome === "ok")).toHaveLength(2);
  expect(calls.filter((r) => (r.payloadJson as { outcome?: string }).outcome === "budget_exceeded")).toHaveLength(1);
});

it("a slow tool call times out to a recoverable tool error; the run continues and can still finish", async () => {
  rig = await startMcpRig({ fixtureFor: () => "mcp-timeout.jsonl" });

  const wf = await seedAssetTask();
  await updateTask(rig.handle.db, { taskId: wf.taskIds.Asset!, limits: { mcp: { call_timeout_ms: 200 } } });

  await triggerTask(rig.handle.db, { taskId: wf.taskIds.Asset! });
  const run = await waitFor("Asset's run to succeed", async () => {
    const [row] = await runsForTask(rig!, wf.taskIds.Asset!);
    return row?.status === "succeeded" ? row : false;
  });
  await waitForQuiet(rig);

  const rows = await waitForTraceRows(rig, run.id, (r) =>
    r.some((x) => (x.payloadJson as { outcome?: string }).outcome === "timeout"),
  );
  const callRow = rows.find((r) => (r.payloadJson as { action?: string }).action === "mcp.call")!;
  expect(callRow.payloadJson).toMatchObject({ server: "fake", tool: "sleep", ok: false, outcome: "timeout" });
});

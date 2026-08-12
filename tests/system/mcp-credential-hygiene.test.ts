import { afterEach, expect, it } from "vitest";
import type { Llm, LlmRequest, LlmResponse } from "@tabductor/agent";
import { newId } from "@tabductor/core";
import { mcpServers } from "@tabductor/db";
import { seedWorkflow, triggerTask } from "@tabductor/engine";
import { createSecret } from "@tabductor/secrets";
import { fakeMcpServerConfig } from "@tabductor/testkit";
import { runsForTask, waitFor, waitForQuiet } from "./engine-support.js";
import { insertFakeMcpServer, startMcpRig, waitForTraceRows, type McpRig } from "./mcp-support.js";

/**
 * S5c deliverable 5's credential test, and §13's whole point about secrets: a server that
 * needs an API key gets one *without the key ever crossing into LLM context, the trace, or
 * anything that would have been written to a recorded transcript*. The fake server
 * (`FAKE_MCP_REQUIRE_KEY_ENV`) refuses every tool call unless the env var
 * `packages/mcp`'s client sets from the redeemed secret is present and non-empty — so a
 * *successful* call is itself proof the value reached the spawned process; the grep afterward
 * is proof it reached nowhere else.
 */

let rig: McpRig | undefined;

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

const SECRET_VALUE = "sk-test-9f3a7c2b-do-not-leak-me";

it("a server requiring an API key succeeds via the broker, and the key appears in neither the trace nor anything the model saw", async () => {
  const userId = "user_test";
  const seenRequests: LlmRequest[] = [];
  const seenResponses: LlmResponse[] = [];

  rig = await startMcpRig({
    fixtureFor: () => "mcp-credential.jsonl",
    wrapLlm: (llm): Llm => ({
      async complete(req) {
        seenRequests.push(req);
        const res = await llm.complete(req);
        seenResponses.push(res);
        return res;
      },
    }),
  });

  const secretId = await createSecret(rig.handle.db, rig.keyWrapper, {
    userId,
    name: "fake-mcp-api-key",
    value: SECRET_VALUE,
    allowedOrigins: [],
  });
  expect(secretId).toBeTruthy();

  await insertFakeMcpServer(rig.handle, { userId, secretName: "fake-mcp-api-key", requireKeyEnv: "API_KEY" });

  const wf = await seedWorkflow(rig.handle.db, {
    userId,
    tasks: { Asset: { kind: "asset", mode: "ai", prompt: "Call the fake MCP server." } },
  });

  await triggerTask(rig.handle.db, { taskId: wf.taskIds.Asset! });
  const run = await waitFor("Asset's run to succeed", async () => {
    const [row] = await runsForTask(rig!, wf.taskIds.Asset!);
    return row?.status === "succeeded" ? row : false;
  });
  await waitForQuiet(rig);

  // Proof the credential actually reached the server: with no key, every tool on this fake
  // server returns `isError`, which would have surfaced as `outcome: "error"`, not "ok" — a
  // run that succeeds here only does so because the env var carried the real value into the
  // spawned process.
  const rows = await waitForTraceRows(rig, run.id, (r) =>
    r.some((x) => (x.payloadJson as { action?: string }).action === "mcp.call"),
  );
  const callRow = rows.find((r) => (r.payloadJson as { action?: string }).action === "mcp.call")!;
  expect(callRow.payloadJson).toMatchObject({ ok: true, outcome: "ok" });

  // The grep itself: the secret's plaintext value appears in none of trace (product data,
  // §13/§17.1), the requests the model was sent, or the responses it returned — zero hits,
  // not "no hits we happened to check for."
  const haystacks = [JSON.stringify(rows), JSON.stringify(seenRequests), JSON.stringify(seenResponses)];
  for (const haystack of haystacks) {
    expect(haystack).not.toContain(SECRET_VALUE);
  }
});

it("negative control: the fake server genuinely refuses the call when nothing injects the credential", async () => {
  const userId = "user_test";
  rig = await startMcpRig({ fixtureFor: () => "mcp-credential.jsonl" });

  // The spawned process is still told to *demand* a key (`FAKE_MCP_REQUIRE_KEY_ENV=API_KEY`,
  // same as the positive test) — but this row's `config_json` names no `secretEnvVar` and no
  // `secret_name`, so nothing ever sets `API_KEY` in that process's environment. This is what
  // proves the positive test's success is load-bearing: without this wiring, the identical
  // fake server genuinely says no.
  const fake = fakeMcpServerConfig({ requireKeyEnv: "API_KEY" });
  await rig.handle.db.insert(mcpServers).values({
    id: newId("mcpserver"),
    userId,
    label: "fake",
    transport: "stdio",
    configJson: { command: fake.command, args: fake.args, env: fake.env, cwd: fake.cwd },
    secretName: null,
  });

  const wf = await seedWorkflow(rig.handle.db, {
    userId,
    tasks: { Asset: { kind: "asset", mode: "ai", prompt: "Call the fake MCP server." } },
  });

  await triggerTask(rig.handle.db, { taskId: wf.taskIds.Asset! });
  const run = await waitFor("Asset's run to finish", async () => {
    const [row] = await runsForTask(rig!, wf.taskIds.Asset!);
    return row && row.status !== "queued" && row.status !== "running" ? row : false;
  });
  await waitForQuiet(rig);

  const rows = await waitForTraceRows(rig, run.id, (r) =>
    r.some((x) => (x.payloadJson as { action?: string }).action === "mcp.call"),
  );
  const callRow = rows.find((r) => (r.payloadJson as { action?: string }).action === "mcp.call")!;
  expect(callRow.payloadJson).toMatchObject({ ok: false, outcome: "error" });
});

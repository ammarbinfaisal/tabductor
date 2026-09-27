import { createServer } from "node:http";
import { expect, it } from "vitest";
import { createPromptWorkflow, triggerTask } from "@tabductor/engine";
import { loadRunTraces } from "@tabductor/compiler";
import { createCamoufoxWorkerDriver } from "@tabductor/browser";
import { remotePythonRunner } from "@tabductor/agent";
import { AllowAllGate } from "@tabductor/policy";
import { startAgentRig, type AgentRig } from "./agent-support.js";
import { runsForTask, waitFor } from "./engine-support.js";

it.skipIf(!process.env.CAMOUFOX_TEST_URL || !process.env.PYTHON_RUNNER_TEST_URL)("recovers from a missing login selector through Python while preserving the uncertain-effect journal", async () => {
  const workerUrl = process.env.CAMOUFOX_TEST_URL!;
  const token = process.env.CAMOUFOX_TEST_TOKEN!;
  const sessionId = "login-recovery-fixture";
  const headers = {authorization:`Bearer ${token}`,"content-type":"application/json","x-tabductor-rpc-version":"1"};
  const response = await fetch(`${workerUrl}/v1/sessions`, {method:"POST",headers,
    body:JSON.stringify({session_id:sessionId,generation:1,profile_dir:sessionId})});
  expect(response.status, await response.text()).toBe(200);
  let clicks = 0;
  const server = createServer(async (req, res) => {
    if (req.url === "/login") { clicks++; res.end("ok"); return; }
    res.setHeader("content-type", "text/html");
    res.end(`<main><div role="link" tabindex="0">Fixture account</div><p>Choose an account</p></main>
      <script>document.querySelector('[role="link"]').onclick=async()=>{
        await fetch('/login',{method:'POST'}); document.querySelector('p').textContent='Signed in';
      };</script>`);
  });
  const host = process.env.CAMOUFOX_FIXTURE_HOST ?? "127.0.0.1";
  let rig: AgentRig | undefined;
  let modelCalls = 0;
  try {
    await new Promise<void>(resolve => server.listen(0, host, resolve));
    const url = `http://${host}:${(server.address() as {port:number}).port}`;
    const sources = [
      `page.goto(browser.input['url'])
assert 'Choose an account' in page.locator('body').inner_text()
page.get_by_role('link',name='Missing account').click(timeout=300)`,
      `page.screenshot()
assert page.locator('p').inner_text() == 'Choose an account'
page.get_by_role('link',name='Fixture account').click()
expect(page.locator('p')).to_have_text('Signed in',timeout=2000)
browser.done(result='login recovered')`,
    ];
    rig = await startAgentRig({
      pythonRunner:remotePythonRunner(process.env.PYTHON_RUNNER_TEST_URL!, process.env.PYTHON_RUNNER_TEST_TOKEN!),
      gate:new AllowAllGate({navAllowlist:[host]}),
      chrome:{wsUrl:workerUrl.replace(/^http/,"ws"),version:"camoufox",close:async()=>{}},
      driver:{connect:()=>createCamoufoxWorkerDriver({token,sessionId,generation:1}).connect(workerUrl)},
      llmFor:()=>({complete:async(request)=>{
        if (modelCalls === 1) {
          const failure = request.messages.flatMap(message => message.toolResults ?? []).find(result => !result.result.ok);
          expect(failure?.name).toBe("browser.python");
          expect(failure && !failure.result.ok ? failure.result.error : undefined).toContain("timed out");
        }
        const source = sources[modelCalls++];
        if (!source) throw new Error("Login recovery required an unexpected extra model turn");
        return {usage:{in:1,out:1},toolCalls:[{id:String(modelCalls),name:"browser.python",args:{source}}]};
      }}),
    });
    const definition = await createPromptWorkflow(rig.handle.db, { accountId: "acct_local", userId: "user_local", prompt: "Sign in and verify" });
    const wf = {taskIds: {Login: definition.versionId}};
    await triggerTask(rig.handle.db, {taskId: wf.taskIds.Login, packet: {url}});
    const run = await waitFor("login recovery", async()=>{
      const [row] = await runsForTask(rig!,wf.taskIds.Login!);
      return row && ["succeeded","failed"].includes(row.status) ? row : false;
    },60000);
    expect(run.status,run.error ?? "").toBe("succeeded");
    expect(modelCalls).toBe(2);
    expect(clicks).toBe(1);
    const [trace] = await loadRunTraces(rig.handle.db,[run.id],rig.blobs);
    expect(trace!.entries.some(e=>e.payload.action === "sdk.operation" && e.payload.name === "playwright.call" &&
      (e.payload.result as {ok?:boolean;outcomeUncertain?:boolean})?.ok === false &&
      (e.payload.result as {outcomeUncertain?:boolean}).outcomeUncertain === true)).toBe(true);
    expect(trace!.entries.some(e=>e.payload.action === "interaction.no_progress")).toBe(false);
  } finally {
    await rig?.stop();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await fetch(`${workerUrl}/v1/sessions/${sessionId}?generation=1`,{method:"DELETE",headers});
  }
},120000);

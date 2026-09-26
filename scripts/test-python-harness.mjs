// Disposable acceptance test. Does not allocate or modify any fleet/session rows.
import { execFileSync, spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { randomUUID } from "node:crypto";

const docker=(...args)=>execFileSync("docker",args,{encoding:"utf8"}).trim();
const run=(command,args,env=process.env)=>new Promise((resolve,reject)=>{
  const child=spawn(command,args,{stdio:"inherit",env});
  child.on("error",reject); child.on("close",code=>code===0?resolve():reject(new Error(`${command} exited ${code}`)));
});
const suffix=randomUUID().slice(0,8), token=randomUUID(), worker=`harness-test-worker-${suffix}`, broker=`harness-test-broker-${suffix}`;
const host=process.env.CAMOUFOX_FIXTURE_HOST ?? Object.values(networkInterfaces()).flat().find(i=>i?.family==="IPv4"&&!i.internal)?.address;
if(!host)throw new Error("Set CAMOUFOX_FIXTURE_HOST to an address reachable from Docker");
const context=JSON.parse(docker("context","inspect"))[0];
const socket=process.env.DOCKER_HOST ?? context.Endpoints.docker.Host;
if(!socket.startsWith("unix://"))throw new Error("This test requires a local Docker Unix socket");
const origin=(name,port)=>`http://${docker("port",name,`${port}/tcp`)}`;
async function ready(url){
  const deadline=Date.now()+90000;
  while(Date.now()<deadline){
    if(await fetch(`${url}/healthz`).then(r=>r.ok).catch(()=>false))return;
    await new Promise(r=>setTimeout(r,250));
  }
  throw new Error(`${url} did not become healthy`);
}
try {
  for(const [tag,file,context] of [
    ["tabductor-browser-worker:harness-test","apps/browser-worker/Dockerfile","."],
    ["tabductor-python-runner:local","vendor/browser-harness/Dockerfile.tabductor","vendor/browser-harness"],
    ["tabductor-python-broker:local","apps/python-runner/Dockerfile","."],
  ])await run("docker",["build","-t",tag,"-f",file,context]);
  docker("run","-d","--rm","--name",broker,"-p","127.0.0.1::8092","-v",`${socket.slice(7)}:/var/run/docker.sock`,"-e",`PYTHON_RUNNER_TOKEN=${token}`,"tabductor-python-broker:local");
  const brokerUrl=origin(broker,8092);
  await ready(brokerUrl);
  const runnerEnv={...process.env,PYTHON_RUNNER_TEST_URL:brokerUrl.replace(/^http/,"ws"),PYTHON_RUNNER_TEST_TOKEN:token};
  await run("pnpm",["exec","vitest","run","tests/system/python-runner-container.test.ts"],runnerEnv);
  // Worker allocation is intentionally single-use, including after session deletion.
  for(const test of ["tests/system/python-captcha.test.ts", "tests/system/playwright-compatibility.test.ts", "tests/system/python-control-reconciliation.test.ts", "tests/system/python-login-recovery.test.ts", "tests/system/python-harness.test.ts", "tests/system/python-dataset.test.ts"]){
    docker("run","-d","--rm","--name",worker,"-p","127.0.0.1::8080","-e",`TABDUCTOR_WORKER_TOKEN=${token}`,"-e","TABDUCTOR_ALLOW_PRIVATE_EGRESS=1","tabductor-browser-worker:harness-test");
    try {
      const workerUrl=origin(worker,8080);await ready(workerUrl);
      await run("pnpm",["exec","vitest","run",test],{
        ...runnerEnv,CAMOUFOX_TEST_URL:workerUrl,CAMOUFOX_TEST_TOKEN:token,CAMOUFOX_FIXTURE_HOST:host,
      });
    } finally {docker("rm","-f",worker);}
  }
} finally {
  for(const name of [broker,worker]){try{execFileSync("docker",["rm","-f",name],{stdio:"ignore"});}catch{/* Already removed or not started. */}}
}

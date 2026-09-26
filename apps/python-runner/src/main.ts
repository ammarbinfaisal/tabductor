/** Trusted broker: one networkless, unprivileged container per run.
 * The engine remains the only browser/effect gateway; no worker/profile credentials
 * or Docker socket are mounted inside generated-code containers.
 */
import { launchRunner, reapExpiredRunners, type RunnerContainer } from "./containers.js";
import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

const token = process.env.PYTHON_RUNNER_TOKEN ?? "";
if (token.length < 32) throw new Error("PYTHON_RUNNER_TOKEN must contain at least 32 characters");
const image = process.env.PYTHON_RUNNER_IMAGE ?? "tabductor-python-runner:local";
const server = createServer((req,res) => { res.writeHead(req.url === "/healthz" ? 200 : 404); res.end(); });
const sockets = new WebSocketServer({ server, maxPayload: 64_000_000 });
const active = new Set<WebSocket>();
const runs = new Map<string,{generation:number;socket:WebSocket}>();
const maxRunners = Number(process.env.PYTHON_RUNNER_MAX ?? 8);
if (!Number.isSafeInteger(maxRunners) || maxRunners < 1) throw new Error("Invalid PYTHON_RUNNER_MAX");
sockets.on("connection", socket => {
  if (active.size >= maxRunners) { socket.close(1013,"Runner capacity reached"); return; }
  active.add(socket);
  let authorized=false, starting=false, child: RunnerContainer | undefined;
  let runId: string | undefined;
  const cancellation=new AbortController();
  const name=`tabductor-python-${randomUUID()}`;
  let bytes=0;
  const send=(stream: string,data: string) => {
    bytes += Buffer.byteLength(data);
    if (bytes > 256_000_000 || socket.bufferedAmount > 64_000_000) { socket.close(1009,"Runner output budget exceeded"); return; }
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({stream,data}));
  };
  const authTimer=setTimeout(()=>socket.close(1008,"Authentication required"),5000);
  const lifetime=setTimeout(()=>socket.close(1008,"Runner deadline exceeded"),30*60*1000);
  socket.on("message", async raw => {
    try {
      const data=String(raw);
      if (!authorized) {
        const candidate=Buffer.from(String(JSON.parse(data).token ?? "")), expected=Buffer.from(token);
        if (candidate.length !== expected.length || !timingSafeEqual(candidate,expected)) { socket.close(1008,"Unauthorized"); return; }
        authorized=true; clearTimeout(authTimer);
        return;
      }
      if (!child) {
        if (starting) throw new Error("Runner is starting");
        starting=true;
        const config=JSON.parse(data);
        if (typeof config.source !== "string" || config.source.length>24000 || !Array.isArray(config.helpers)) throw new Error("Invalid invocation");
        if (config.scope) {
          const scope = config.scope;
          if (typeof scope.runId !== "string" || !Number.isSafeInteger(scope.leaseGeneration) || scope.leaseGeneration < 0) throw new Error("Invalid run scope");
          const prior = runs.get(scope.runId);
          if (prior && prior.generation >= scope.leaseGeneration) throw new Error("Run already attached");
          prior?.socket.close(1008,"Run lease superseded");
          runId = scope.runId;
          runs.set(runId!,{generation:scope.leaseGeneration,socket});
        }
        child=await launchRunner(name,image,cancellation.signal);
        if (socket.readyState !== WebSocket.OPEN) {child.kill();return;}
        child.stdout.on("data",chunk=>send("stdout",String(chunk)));
        child.stderr.on("data",chunk=>send("stderr",String(chunk)));
        child.on("error",()=>{ socket.send(JSON.stringify({error:"Runner container could not start"})); socket.close(); });
        child.on("close",()=>socket.close());
      }
      if (child.stdin.writableLength > 64_000_000) throw new Error("Runner input budget exceeded");
      child.stdin.write(data+"\n");
    } catch { socket.close(1008,"Invalid runner protocol"); }
  });
  socket.on("error",()=>socket.close());
  socket.on("close",()=>{
    clearTimeout(authTimer); clearTimeout(lifetime); active.delete(socket);
    if (runId && runs.get(runId)?.socket === socket) runs.delete(runId);
    cancellation.abort(); child?.kill();
  });
});
const reap=()=>void reapExpiredRunners().catch(()=>process.stderr.write("Python sandbox cleanup failed; will retry\n"));
reap();
const reaper=setInterval(reap,60000);reaper.unref();
const stop=()=>{clearInterval(reaper); for (const socket of active) socket.close(1001,"Broker shutting down"); sockets.close(); server.close(); };
process.on("SIGTERM",stop); process.on("SIGINT",stop);
server.listen(Number(process.env.PORT ?? 8092),"0.0.0.0");

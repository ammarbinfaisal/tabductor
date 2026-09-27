import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunWorkspace } from "./workspace.js";
import type { runToolScript } from "@tabductor/static-rt";
import { pythonOutputPreview } from "./code-output.js";

export type PythonCallContext = { sessionId?: string; parent?: unknown; sdkCallId?: number; callbackId?: string; requestCallback: (event: unknown) => Promise<unknown> };
export type PythonHostCall = (name: string, args: unknown, signal: AbortSignal, wait: <T>(work: () => Promise<T>) => Promise<T>, context?: PythonCallContext) => Promise<unknown>;
export type PythonRunnerOptions = NonNullable<Parameters<typeof runToolScript>[2]> & { workspace?: RunWorkspace; onOutput?: (output: string) => Promise<void>; onSdkCall?: (event: unknown) => Promise<void>; onReady?: (sessionId: string) => void; compiled?: boolean; invocationId?: string };
export type RunnerScope = { runId: string; leaseGeneration: number };
export type PythonRunner = ((source: string, call: PythonHostCall, opts?: PythonRunnerOptions) => ReturnType<typeof runToolScript>) & {
  open?: (scope: RunnerScope) => PythonRunner;
  close?: () => Promise<void>;
  persistent?: boolean;
  /** Runs on disconnect/reset as well as final close, to release browser-object scopes. */
  onClose?: (cleanup: () => Promise<void>) => void;
  reset?: () => Promise<void>;
};
type Channel = { send(data: string): void; close(force?: boolean): void };
type Connect = (receive: (data: string) => void, ended: (error?: Error) => void) => Promise<Channel>;

/** Auth is sent in the first frame, never in a URL, model prompt or trace. */
export function remotePythonRunner(url: string, token: string): PythonRunner {
  if (!url || !token) throw new Error("Python harness requires PYTHON_RUNNER_URL and PYTHON_RUNNER_TOKEN");
  return runnerFactory((receive, ended) => new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => { socket.close(); reject(new Error("Python runner connection timed out")); }, 10000);
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Python runner connection failed")); ended(new Error("Python runner connection failed")); });
    socket.addEventListener("close", () => { clearTimeout(timer); ended(); });
    socket.addEventListener("message", event => receive(String(event.data)));
    socket.addEventListener("open", () => {
      clearTimeout(timer); socket.send(JSON.stringify({ token }));
      resolve({ send: data => socket.send(data), close: () => socket.close() });
    });
  }));
}

/** Test seam only. Production uses the networkless container service above. */
export function localPythonRunnerForTest(script: string): PythonRunner {
  return runnerFactory(async (receive, ended) => {
    const cwd = await mkdtemp(join(tmpdir(), "tabductor-python-"));
    const child = spawn("python3", ["-I", fileURLToPath(new URL("../python/runner.py", import.meta.url)), script, "--supervise"], { cwd, env: { PATH: process.env.PATH, NODE_ENV: "test" }, detached:true, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    child.stdout.on("data", chunk => {
      buffer += String(chunk);
      while (buffer.includes("\n")) { const end = buffer.indexOf("\n"); receive(JSON.stringify({ stream: "stdout", data: buffer.slice(0,end+1) })); buffer=buffer.slice(end+1); }
    });
    child.stderr.on("data", chunk => receive(JSON.stringify({ stream: "stderr", data: String(chunk) })));
    child.on("error", ended);
    child.on("close", code => { void rm(cwd, { recursive: true, force: true }); ended(code ? new Error(`Python exited ${code}`) : undefined); });
    return { send: data => { child.stdin.write(data + "\n"); }, close: () => { if (child.pid) { try { process.kill(-child.pid,"SIGKILL"); } catch { /* already exited */ } } } };
  });
}

/** A bound runner owns one persistent interpreter; cells are serialized within a run. */
function runnerFactory(connect: Connect): PythonRunner {
  const root = pythonRunner(connect);
  root.open = scope => {
    let channel: Channel | undefined;
    let receive: (data: string) => void = () => undefined;
    let ended: (error?: Error) => void = () => undefined;
    let busy = false;
    let generation = 0;
    let closed = false;
    let cleanup: Promise<unknown> = Promise.resolve();
    const cleanups = new Set<() => Promise<void>>();
    const reset = () => {
      generation++;
      const previous = channel;
      channel = undefined;
      previous?.close(true);
      cleanup = cleanup.then(() => Promise.allSettled([...cleanups].map(fn => fn())));
    };
    const invoke = pythonRunner(async (nextReceive, nextEnded) => {
      receive = nextReceive; ended = nextEnded;
      if (!channel) {
        await cleanup;
        if (closed) throw new Error("Python runner is closed");
        const current = ++generation;
        const connected = await connect(data => { if(current===generation) receive(data); }, error => { if(current===generation) { reset(); ended(error); } });
        if (closed || current !== generation) { connected.close(true); throw new Error("Python runner disconnected while connecting"); }
        channel = connected;
      }
      return { send: data => channel!.send(data), close: force => { if (force) reset(); } };
    }, scope);
    const bound: PythonRunner = async (...args) => {
      if (busy) throw new Error("Python runner already executing a cell");
      if (closed) throw new Error("Python runner is closed");
      busy = true;
      try { return await invoke(...args); } finally { busy = false; }
    };
    bound.persistent = true;
    // Replay validation must create a fresh sandbox even when given a bound runner.
    bound.open = root.open;
    bound.onClose = fn => { cleanups.add(fn); };
    bound.reset = async () => { reset(); ended(new Error("Python interpreter reset")); await cleanup; };
    bound.close = async () => { closed = true; reset(); ended(new Error("Python runner closed")); await cleanup; };
    return bound;
  };
  return root;
}

function pythonRunner(connect: Connect, scope?: RunnerScope): PythonRunner {
  return async (source, call, opts = {}) => {
    let calls=0, output="", buffer="", channel:Channel|undefined, complete=false, ready=false, sessionId:string|undefined;
    let timer:ReturnType<typeof setTimeout>|undefined, remaining=opts.wallClockMs ?? 180000, started=0;
    const disconnected=new AbortController();
    const operationSignal=opts.signal?AbortSignal.any([opts.signal,disconnected.signal]):disconnected.signal;
    const tasks=new Set<Promise<void>>();
    const callbacks=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();
    let resolve!:(value:Awaited<ReturnType<typeof runToolScript>>)=>void;
    const result=new Promise<Awaited<ReturnType<typeof runToolScript>>>(r=>{resolve=r;});
    const pause=()=>{if(timer){clearTimeout(timer);timer=undefined;if(started)remaining-=Date.now()-started;}started=0;};
    const finish=(value:Awaited<ReturnType<typeof runToolScript>>)=>{if(complete)return;complete=true;pause();disconnected.abort();for(const pending of callbacks.values())pending.reject(new Error("Python invocation ended"));callbacks.clear();resolve(value);};
    const arm=()=>{pause();if(complete)return;started=Date.now();timer=setTimeout(()=>{channel?.close(true);finish({outcome:"killed",error:"Python execution budget exceeded",effectsSettled:false,calls});},Math.max(1,remaining));};
    const fail=(error:unknown)=>{channel?.close(true);finish({outcome:"error",effectsSettled:false,error:String(error),calls});};
    const abort=()=>fail("run_cancelled");
    const requestCallback=async(event:unknown)=>{
      const id=String((event as {id:string}).id);
      const reply=new Promise<unknown>((resolve,reject)=>callbacks.set(id,{resolve,reject}));
      channel!.send(JSON.stringify({type:"callback",event}));arm();
      try{return await reply;}finally{callbacks.delete(id);}
    };
    const handle=async(request:Record<string,unknown>)=>{
      if(complete)return;
      if(request.type==="ready"){
        if(request.protocolVersion!==4 || typeof request.sessionId!=="string")throw new Error("Incompatible Python runner: protocol v4 required for persistent Python cells");
        sessionId=request.sessionId;opts.onReady?.(sessionId);
        ready=true;clearTimeout(timer);timer=undefined;arm();return;
      }
      if(request.type==="output"){
        output+=String(request.text??"");if(output.length>16000000)throw new Error("Python output exceeds 16 MB");return;
      }
      if(request.type==="sdk"){await opts.onSdkCall?.(request.event);return;}
      if(request.type==="callback_result"){
        pause();const pending=callbacks.get(String(request.id));
        if(!pending)throw new Error("Unknown callback response");
        if(request.ok)pending.resolve(request.value);else pending.reject(new Error(String(request.error)));return;
      }
      if(request.type==="result"){
        finish(request.ok?{outcome:"completed",value:pythonOutputPreview(output),calls}:{outcome:"error",effectsSettled:tasks.size<=1,error:String(request.error??"Python failed")+(output?"\nOutput:\n"+pythonOutputPreview(output).output:""),calls});return;
      }
      if(!ready || request.type!=="call" || ++calls>(opts.maxCalls??1000))throw new Error("Invalid Python protocol or operation budget exceeded");
      pause();
      let value:unknown;
      try {value=await call(String(request.name),request.args,operationSignal,async work=>work(),{
        sessionId,parent:request.parent,sdkCallId:typeof request.sdkCallId==="number"?request.sdkCallId:undefined,
        callbackId:typeof request.callbackId==="string"?request.callbackId:undefined,requestCallback});}
      catch(error){value={ok:false,error:String(error)};}
      if(!complete){channel!.send(JSON.stringify({id:request.id,result:value}));arm();}
    };
    const receive=(data:string)=>{
      if(complete)return;
      try{
        const frame=JSON.parse(data) as {stream?:string;data?:string;error?:string};
        if(frame.error)throw new Error(frame.error);
        if(frame.stream==="stderr"){output+=frame.data??"";if(output.length>16000000)throw new Error("Python output exceeds 16 MB");return;}
        buffer+=frame.data??"";if(buffer.length>64000000)throw new Error("Python protocol exceeds 64 MB");
        while(buffer.includes("\n")){
          const end=buffer.indexOf("\n"),line=buffer.slice(0,end);buffer=buffer.slice(end+1);
          const task=handle(JSON.parse(line)).catch(fail);tasks.add(task);void task.finally(()=>tasks.delete(task));
        }
      }catch(error){fail(error);}
    };
    try{
      opts.signal?.throwIfAborted();
      channel=await connect(receive,error=>{finish({outcome:"error",effectsSettled:false,error:error?.message??"Python runner disconnected",calls});});
      opts.signal?.addEventListener("abort",abort,{once:true});if(opts.signal?.aborted)abort();
      if(!complete){
        timer=setTimeout(()=>fail("Python runner startup timed out"),70000);
        channel.send(JSON.stringify({source,input:opts.input,helpers:opts.helpers??[],scope,repl:!!scope,workspace:await opts.workspace?.snapshot(),compiled:opts.compiled??false,invocationId:opts.invocationId}));
      }
      return await result;
    }finally{
      pause();opts.signal?.removeEventListener("abort",abort);channel?.close();await Promise.allSettled([...tasks]);
      if(output)await opts.onOutput?.(output);
    }
  };
}

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { Attach, CoreV1Api, KubeConfig } from "@kubernetes/client-node";

export type RunnerContainer = { stdin:Writable; stdout:Readable; stderr:Readable; on:(event:string,listener:(...args:unknown[])=>void)=>unknown; kill:()=>unknown };

const owner = process.env.PYTHON_RUNNER_OWNER ?? "tabductor-local";
const command = promisify(execFile);

/** Reap expired sandboxes after a broker crash, scoped to this installation. */
export async function reapExpiredRunners(): Promise<void> {
  const now = Math.floor(Date.now()/1000);
  if (process.env.PYTHON_RUNNER_DRIVER !== "kubernetes") {
    const {stdout} = await command("docker",["ps","-aq","--filter",`label=tabductor.python-owner=${owner}`]);
    for (const id of stdout.trim().split(/\s+/).filter(Boolean)) {
      const info = await command("docker",["inspect","--format",'{{index .Config.Labels "tabductor.python-deadline"}}',id]);
      if (Number(info.stdout.trim()) <= now) await command("docker",["rm","-f",id]);
    }
    return;
  }
  const config = new KubeConfig(); config.loadFromDefault();
  const core = config.makeApiClient(CoreV1Api), namespace = process.env.POD_NAMESPACE ?? "default";
  const pods = await core.listNamespacedPod({namespace,labelSelector:`tabductor.io/python-owner=${owner}`});
  for (const pod of pods.items) if (pod.metadata?.name && Number(pod.metadata.annotations?.["tabductor.io/deadline"]) <= now)
    await core.deleteNamespacedPod({namespace,name:pod.metadata.name});
}

export async function launchRunner(name:string,image:string,signal:AbortSignal):Promise<RunnerContainer> {
  const expires = String(Math.floor(Date.now()/1000)+1800);
  if (process.env.PYTHON_RUNNER_DRIVER !== "kubernetes") {
    const child=spawn("docker",["run","--rm","-i","--name",name,"--label",`tabductor.python-owner=${owner}`,"--label",`tabductor.python-deadline=${expires}`,"--network","none","--read-only","--tmpfs","/tmp:rw,nosuid,nodev,size=32m,mode=1777",
      "--tmpfs","/workspace:rw,nosuid,nodev,size=64m,mode=700,uid=10001,gid=10001","--memory","512m","--memory-swap","512m","--cpus","1","--pids-limit","32","--cap-drop","ALL","--security-opt","no-new-privileges",image],{stdio:["pipe","pipe","pipe"]});
    const terminate=child.kill.bind(child);
    const kill=()=>{terminate();spawn("docker",["rm","-f",name],{stdio:"ignore"}).on("error",()=>undefined);};
    signal.addEventListener("abort",kill,{once:true});
    if(signal.aborted)kill();
    child.on("close",()=>signal.removeEventListener("abort",kill));
    return Object.assign(child,{kill});
  }
  const config=new KubeConfig();config.loadFromDefault();
  const core=config.makeApiClient(CoreV1Api), namespace=process.env.POD_NAMESPACE ?? "default";
  const streams=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),
    kill:()=>{void core.deleteNamespacedPod({namespace,name}).catch(()=>undefined);}});
  signal.addEventListener("abort",streams.kill,{once:true});
  try {
    await core.createNamespacedPod({namespace,body:{apiVersion:"v1",kind:"Pod",metadata:{name,labels:{"app.kubernetes.io/name":"tabductor-python-execution","tabductor.io/python-owner":owner},annotations:{"tabductor.io/deadline":expires}},
      spec:{nodeSelector:JSON.parse(process.env.PYTHON_RUNNER_NODE_SELECTOR ?? "{}"),automountServiceAccountToken:false,restartPolicy:"Never",activeDeadlineSeconds:1800,terminationGracePeriodSeconds:1,
        securityContext:{runAsUser:10001,runAsGroup:10001,fsGroup:10001,runAsNonRoot:true,seccompProfile:{type:"RuntimeDefault"}},
        containers:[{name:"runner",image,stdin:true,stdinOnce:true,tty:false,
          securityContext:{allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,capabilities:{drop:["ALL"]}},
          resources:{requests:{cpu:"100m",memory:"64Mi"},limits:{cpu:"1",memory:"512Mi"}},
          volumeMounts:[{name:"scratch",mountPath:"/tmp"},{name:"workspace",mountPath:"/workspace"}]}],volumes:[{name:"scratch",emptyDir:{medium:"Memory",sizeLimit:"32Mi"}},{name:"workspace",emptyDir:{sizeLimit:"64Mi"}}]}}});
    const deadline=Date.now()+60000;
    while(Date.now()<deadline) {
      signal.throwIfAborted();
      const pod=await core.readNamespacedPod({namespace,name});
      if(pod.status?.phase==="Running") {
        const connection=await new Attach(config).attach(namespace,name,"runner",streams.stdout,streams.stderr,streams.stdin,false);
        connection.on("close",()=>{signal.removeEventListener("abort",streams.kill);streams.emit("close");streams.kill();});
        connection.on("error",error=>streams.emit("error",error));
        return streams;
      }
      if(["Failed","Succeeded"].includes(pod.status?.phase ?? ""))throw new Error("Runner exited before attach");
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    throw new Error("Runner pod did not start within 60 seconds");
  } catch(error) {streams.kill();throw error;}
}

// Disposable namespace acceptance against an existing kind cluster.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const run=(cmd,args,options={})=>execFileSync(cmd,args,{encoding:'utf8',...options});
const node=process.env.KUBECTL_CONTAINER ?? 'tabductor-staging-control-plane';
const kubectl=(...args)=>run('docker',['exec',node,'kubectl',...args]);
const namespace=`python-accept-${randomUUID().slice(0,8)}`, release='python-accept', full=`${release}-tabductor`;
const scratch=mkdtempSync(join(tmpdir(),'python-kubernetes-'));
const token=randomUUID()+randomUUID();
try {
  const nodes=run('docker',['ps','--filter','label=io.x-k8s.kind.cluster=tabductor-staging','--format','{{.Names}}']).trim().split(/\s+/).filter(Boolean);
  if(!nodes.length)throw Error('Start the staging kind cluster before Kubernetes acceptance');
  const archive=join(scratch,'images.tar');
  run('docker',['save','-o',archive,'tabductor-python-broker:local','tabductor-python-runner:local']);
  for(const name of nodes){
    run('docker',['cp',archive,`${name}:/var/tmp/${namespace}.tar`]);
    try {run('docker',['exec',name,'ctr','-n','k8s.io','images','import',`/var/tmp/${namespace}.tar`]);}
    finally {run('docker',['exec',name,'rm','-f',`/var/tmp/${namespace}.tar`]);}
  }
  kubectl('create','namespace',namespace);
  const secret={apiVersion:'v1',kind:'Secret',metadata:{name:`${full}-config`,namespace},stringData:{PYTHON_RUNNER_TOKEN:token}};
  run('docker',['exec','-i',node,'kubectl','apply','-f','-'],{input:JSON.stringify(secret)});
  const chart=run('docker',['run','--rm','-v',`${process.cwd()}/infra/helm/tabductor:/chart:ro`,'alpine/helm:3.16.4',
    'template',release,'/chart','--namespace',namespace,'--set','pythonRunner.enabled=true','--show-only','templates/python-runner.yaml']);
  run('docker',['exec','-i',node,'kubectl','-n',namespace,'apply','-f','-'],{input:chart});
  kubectl('-n',namespace,'rollout','status',`deployment/${full}-python-runner`,'--timeout=90s');
  const check=`
    import { networkInterfaces } from 'node:os';
    const address=Object.values(networkInterfaces()).flat().find(i=>i.family==='IPv4'&&!i.internal).address;
    const source=[
      'import os,socket', 'from pathlib import Path', 'assert os.getuid()==10001',
      "assert not Path('/var/run/secrets/kubernetes.io/serviceaccount/token').exists()",
      "assert not Path('/var/run/docker.sock').exists()",
      "try:\\n    socket.create_connection(('"+address+"',8092),timeout=0.5)\\n    raise AssertionError('network policy escaped')\\nexcept OSError: pass",
      "Path('persisted.txt').write_text('durable cell')",'transient=42',"print('isolation passed')"
    ].join('\\n');
    const socket=new WebSocket('ws://127.0.0.1:8092');
    let stage=0,buffer='',output='';
    const timer=setTimeout(()=>{console.error('Runner acceptance timed out');process.exit(1)},80000);
    const send=source=>socket.send(JSON.stringify({source,helpers:[],scope:{runId:'acceptance',leaseGeneration:1}}));
    socket.onopen=()=>{socket.send(JSON.stringify({token:process.env.PYTHON_RUNNER_TOKEN}));send(source)};
    socket.onerror=()=>{console.error('Runner connection failed');process.exit(1)};
    socket.onmessage=event=>{
      const envelope=JSON.parse(event.data);
      if(envelope.stream==='stderr'){output+=envelope.data;return}
      buffer+=envelope.data??'';
      while(buffer.includes('\\n')){
        const end=buffer.indexOf('\\n'),line=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
        if(line.type==='result'){
          if(!line.ok)throw Error(line.error);
          if(stage++===0)send("assert 'transient' not in globals()\\nassert open('persisted.txt').read()=='durable cell'\\nprint('fresh globals and files passed')");
          else {if(!output.includes('isolation passed')||!output.includes('fresh globals and files passed'))throw Error('Missing output');clearTimeout(timer);socket.close();console.log('Kubernetes isolation, fresh globals, and persistent sandbox passed')}
        }
      }
    };
  `;
  process.stdout.write(run('docker',['exec','-i',node,'kubectl','-n',namespace,'exec','-i',`deployment/${full}-python-runner`,'--','node','--input-type=module','-'],{input:check,timeout:100000}));
  kubectl('-n',namespace,'wait','--for=delete','pod','-l','app.kubernetes.io/name=tabductor-python-execution','--timeout=30s');
  console.log('Kubernetes runner cleanup passed');
} finally {
  try {kubectl('delete','namespace',namespace,'--ignore-not-found','--wait=false');} finally {rmSync(scratch,{recursive:true,force:true});}
}

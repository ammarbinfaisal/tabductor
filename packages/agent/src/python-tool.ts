import { randomUUID } from "node:crypto";
import { asSchema } from "ai";
import { z } from "zod";
import { AppError } from "@tabductor/core";
import { playwrightManifest, proxyMember, PLAYWRIGHT_API_VERSION, type ProxyCall } from "@tabductor/browser";
import { defineTool, doneTool, failTool, emitTool, type AgentTool, type AgentToolDeps, type ToolImage, type ToolResult } from "./tools.js";
import { batchTools } from "./batch-tools.js";
import { captchaTools } from "./captcha-tools.js";
import { recordOutcomeTool } from "./record-tools.js";
import { sdkEvidence } from "./code-tool.js";
import { PYTHON_BROWSER_GUIDANCE, pythonWorkflowGuidance } from "./python-guidance.js";
import { browserJavascript } from "./browser-javascript.js";
import { terminalBrowserError } from "./browser-actions.js";
import type { PythonCallContext } from "./python-runner.js";

const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string,unknown> : {};
const ref = z.object({id:z.string(),class:z.string(),scope:z.string()}).passthrough();
const callSchema = z.object({target:ref,member:z.string(),args:z.array(z.unknown()),kwargs:z.record(z.unknown())});
const readWorkflow = new Set(["describe","history.read","output.read","memory.get","captcha.providers","captcha.get_result","captcha.wait","deopt","fail"]);

/** One public execution tool, one Playwright proxy, and separate workflow services. */
export function pythonTool(deps: AgentToolDeps): AgentTool {
  if (!deps.pythonRunner) throw new Error("Browser runs require a Python runner");
  if (!deps.session.page.proxy) throw new Error("Browser runs require the Camoufox Playwright proxy");
  const memory = deps.memory ?? (() => {let value:unknown={facts:[],pending:[]};return {get:async()=>value,set:async(v:unknown)=>{value=v;}};})();
  const workflow: AgentTool[] = [emitTool(deps.emit),doneTool(),failTool(),
    ...batchTools(deps.session,deps.emit,deps.signal,deps.progress).filter(t=>t.name==="emit.batch"),
    ...captchaTools(deps.captcha, deps.beforeCall),
    defineTool({name:"memory.get",description:"Read exploration facts and pending work.",parameters:z.object({}),execute:async()=>({ok:true,value:await memory.get()})}),
    defineTool({name:"memory.set",description:"Save concise observed facts and pending work.",parameters:z.object({facts:z.array(z.string().max(500)).max(12),pending:z.array(z.string().max(500)).max(8)}),execute:async value=>{await memory.set(value);return {ok:true,value:{saved:true}};}}),
    defineTool({name:"deopt",description:"Hand off the current state to AI reasoning.",parameters:z.object({reason:z.string().min(1),evidence:z.unknown().optional()}),execute:async value=>({ok:true,value})}),
    defineTool({name:"yield_control",description:"End this invocation and return control to the agent.",parameters:z.object({}),execute:async()=>({ok:true,value:null})}),
  ];
  const allowed=new Map(workflow.map(t=>[`workflow.${t.name}`,t]));
  for(const tool of deps.workspace?.tools()??[]) allowed.set(tool.name==="output.read"?`workflow.${tool.name}`:`internal.${tool.name}`,tool);
  if(deps.contextHistory) allowed.set("workflow.history.read",defineTool({name:"history.read",description:"Search or page the durable operation archive.",
    parameters:z.object({name:z.string().optional(),invocationId:z.string().optional(),query:z.string().optional(),failedOnly:z.boolean().default(false),sequence:z.number().int().positive().optional(),before:z.number().int().positive().optional(),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(8000).default(4000)}),
    execute:async args=>({ok:true,value:await deps.contextHistory!.read(args)})}));
  const availableWorkflow = [...allowed.keys()].filter(name => name.startsWith("workflow."));
  availableWorkflow.push("workflow.describe");
  if (deps.fillSecret) availableWorkflow.push("workflow.secrets.fill");
  if (deps.recordOutcome) availableWorkflow.push("workflow.record.outcome");
  return defineTool({name:"browser.python",description:`${PYTHON_BROWSER_GUIDANCE}\n${pythonWorkflowGuidance(availableWorkflow)}`,
    parameters:z.object({source:z.string().min(1).max(24000),timeoutMs:z.number().int().min(1).max(180000).default(180000)}),
    async execute(args, callSignal) {
      const signal=deps.signal&&callSignal?AbortSignal.any([deps.signal,callSignal]):deps.signal??callSignal??new AbortController().signal;
      const invocationId=randomUUID(), images:ToolImage[]=[];
      const workspaceBefore=await deps.workspace?.snapshot()??{};
      const helpers=deps.pinnedHelpers??await deps.helpers?.list()??[];
      let terminal:ToolResult["terminal"], yielded=false, stopped=false, fatal:unknown, sequence=0, sensitiveInvocation=false;
      const running=new Map<string,{operationId:string;tool:string;effect:boolean}>();
      let stateQueue:Promise<unknown>=Promise.resolve();
      let historyQueue:Promise<unknown>=Promise.resolve();
      const state=(fn:(current:Record<string,unknown>)=>Record<string,unknown>)=>{
        const next=stateQueue.then(async()=>{const value=fn(obj(await deps.progress?.get()));await deps.progress?.set(value);});stateQueue=next.catch(()=>undefined);return next;
      };
      const archive=async(payload:Record<string,unknown>)=>{
        const bytes=Buffer.from(JSON.stringify(payload));
        await deps.trace?.record("action",bytes.length>64000?{...payload,args:undefined,result:undefined,evidenceArtifact:true}:payload,
          bytes.length>64000?{kind:"actions",bytes,mime:"application/json"}:undefined);
      };
      const proxy=async(command:Parameters<NonNullable<typeof deps.session.page.proxy>>[0], context?:PythonCallContext, parentOperationId?:string)=>
        deps.session.page.proxy!(command,{invocation:invocationId,signal,callback:async event=>{
          if(!context)throw new Error("Callback transport unavailable");
          await archive({action:"playwright.callback",phase:"started",invocationId,...event,parentOperationId:event.parentJob??parentOperationId});
          try {const value=await context.requestCallback(event);await archive({action:"playwright.callback",phase:"finished",invocationId,parentOperationId,id:event.id,value:sdkEvidence(value)});return value;}
          catch(error){await archive({action:"playwright.callback",phase:"finished",invocationId,parentOperationId,id:event.id,error:String(error)});throw error;}
        }});
      const registry=new Map(allowed);
      if(deps.fillSecret)registry.set("workflow.secrets.fill",defineTool({name:"secrets.fill",description:"Fill a named secret into a live locator without returning plaintext.",
        parameters:z.object({name:z.string(),locator:z.object({$ref:ref})}),execute:async a=>{
          const target=obj(await proxy({command:"inspect",target:a.locator.$ref,pin:randomUUID()}));
          if(!target.selector||target.origin!==target.pageOrigin)return {ok:false,error:"Secret target must be an unambiguous same-origin input"};
          if(target.pageId!==deps.session.page.id&&deps.session.page.switchTab)deps.session.page=await deps.session.page.switchTab(String(target.pageId));
          const observation=await deps.session.page.perceive({selector:String(target.selector)});
          const inputs=observation.elements.filter(e=>e.tag==="input"||e.tag==="textarea");
          if(inputs.length!==1)return {ok:false,error:"Secret target could not be pinned"};
          return {ok:true,value:await deps.fillSecret!(a.name,inputs[0]!.anchor)};
        }}));
      if(deps.recordOutcome) registry.set("workflow.record.outcome",recordOutcomeTool(deps.recordOutcome));
      registry.set("workflow.describe",defineTool({name:"describe",description:"Inspect the supported Playwright and workflow API.",parameters:z.object({name:z.string().optional()}),execute:async({name})=>{
        if(!name)return {ok:true,value:{browser:playwrightManifest,workflow:[...registry.keys()].filter(n=>n.startsWith("workflow."))}};
        const tool=registry.get(name.startsWith("workflow.")?name:`workflow.${name}`);
        if(tool)return {ok:true,value:{name:tool.name,description:tool.description,parameters:asSchema(tool.parameters).jsonSchema}};
        const [cls,member]=name.replace(/^page\./,"Page.").split(".");
        const value=member?playwrightManifest.classes[cls!]?.[member]:playwrightManifest.classes[cls!];
        return value?{ok:true,value}:{ok:false,error:`Unknown or unavailable API member for this task. ${pythonWorkflowGuidance(availableWorkflow)}`};
      }}));
      await state(current=>({...current,...(current.inFlight?{requiresReconciliation:true,uncertainOperation:current.inFlight,inFlight:null}:{})}));
      const result=await deps.pythonRunner!(args.source,async(name,input,operationSignal,_wait,context)=>{
        const internal=name.startsWith("internal.")||name==="playwright.close";
        signal.throwIfAborted();operationSignal.throwIfAborted();
        if(!internal&&(terminal||stopped))return {ok:false,error:"Program stopped; return control to AI"};
        try{if(!internal&&await deps.beforeCall?.()){stopped=true;return {ok:false,error:"Browser control changed; start a fresh invocation"};}}catch(error){if(terminalBrowserError(error))fatal=error;throw error;}
        let call:ProxyCall|undefined, invalid:unknown;
        let spec:ReturnType<typeof proxyMember>|undefined;
        try{if(name==="playwright.call"){call=callSchema.parse(input) as ProxyCall;spec=proxyMember(call);}}catch(error){invalid=error;}
        const effect=invalid?false:call?spec!.kind==="effect":name.startsWith("workflow.")&&!readWorkflow.has(name.slice(9))&&!internal;
        let sensitive=(name.startsWith("workflow.captcha.") && name!=="workflow.captcha.providers") || name==="workflow.secrets.fill" || !!(call&&deps.storageFlags?.network===false&&["Request","Response","APIRequestContext","APIResponse"].includes(call.target.class));
        if(call&&["fill","type","insert_text","press_sequentially"].includes(call.member)){
          const target=await proxy({command:"inspect",call}).catch(()=>null);
          sensitive ||= !target||obj(target).type==="password"||obj(target).origin!==obj(target).pageOrigin;
        }
        sensitiveInvocation ||= sensitive;
        const operationId=randomUUID(),start=Date.now();
        const entry={operationId,invocationId,sequence:sequence++,name,effect,...(context?.callbackId?{callbackId:context.callbackId}:{})};
        const argumentsEvidence=deps.storageFlags?.actions===false||sensitive?{evidenceOmitted:true,reason:"sensitive"}:sdkEvidence(input,64_000_000);
        await archive({action:"sdk.operation",phase:"started",...entry,args:argumentsEvidence});
        running.set(operationId,{operationId,tool:name,effect});
        if(effect){await state(current=>({...current,inFlight:[...running.values()].filter(v=>v.effect)}));await deps.trace?.flush();}
        let value:ToolResult;
        try{
          if(invalid)throw invalid;
          if(deps.compiled&&effect&&obj(await deps.progress?.get()).requiresReconciliation)throw new Error("Uncertain effect requires AI reconciliation");
          if(name==="playwright.open")value={ok:true,value:await proxy({command:"open"},context)};
          else if(name==="playwright.close")value={ok:true,value:await deps.session.page.proxy!({command:"close"},{invocation:invocationId})};
          else if(name==="playwright.expect")value={ok:true,value:await proxy({command:"expect",target:ref.parse(obj(input).target),message:typeof obj(input).message==="string"?String(obj(input).message):undefined,timeout:typeof obj(input).timeout==="number"?Number(obj(input).timeout):undefined},context)};
          else if(call){
            if(["evaluate","evaluate_handle","evaluate_all"].includes(call.member)&&typeof call.args[0]==="string")call.args[0]=browserJavascript(call.args[0]);
            const output=await proxy({command:"call",call:{...call,operationId,...(context?.callbackId?{callback:context.callbackId}:{})}},context,operationId);
            if(call.member==="screenshot"&&typeof obj(output).$bytes==="string")images.splice(0,images.length,{data:String(obj(output).$bytes),mime:call.kwargs.type==="jpeg"?"image/jpeg":"image/png"});
            value={ok:true,value:output};
          }else if(name==="internal.helpers.use")value={ok:true,value:helpers.find(h=>h.name===obj(input).name&&h.revision===obj(input).revision)??null};
          else if(name==="internal.helpers.define"&&!deps.compiled&&deps.helpers){const a=obj(input);if(a.name!=="agent_helpers"||typeof a.source!=="string"||a.source.length>24000)throw new Error("Invalid helper module");value={ok:true,value:await deps.helpers.define("agent_helpers",a.source)};}
          else {
            const tool=registry.get(name);if(!tool)throw new Error(`Unavailable operation: ${name}`);
            if(name==="workflow.done"){
              const error=await deps.recordCompletionError?.();if(error)throw new Error(error);
            }
            value=await tool.execute(input,signal);
          }
          if(value.ok&&name==="workflow.done")terminal={outcome:"done",result:value.value};
          if(value.ok&&name==="workflow.fail")terminal={outcome:"fail",reason:String(value.value)};
          if(value.ok&&name==="workflow.deopt")terminal={outcome:"deopt",reason:String(obj(input).reason),evidence:obj(input).evidence};
          if(value.ok&&name==="workflow.yield_control")yielded=true;
        }catch(error){
          if(terminalBrowserError(error))fatal=error;
          value={ok:false,error:String(error),...(error instanceof AppError?{code:error.code}:{}),outcomeUncertain:effect&&!(error instanceof AppError&&error.details?.outcomeUncertain===false)};
        }
        running.delete(operationId);
        await state(current=>({...current,inFlight:[...running.values()].filter(v=>v.effect).length?[...running.values()].filter(v=>v.effect):null,
          ...(value.outcomeUncertain?{requiresReconciliation:true,uncertainOperation:entry}:{}),
          ...(value.ok&&effect?{lastAcknowledgedOperation:operationId}:{})}));
        if(!value.ok&&deps.compiled&&!internal){stopped=true;terminal={outcome:"deopt",reason:value.error,evidence:{operationId}};}
        const evidence=sensitive||deps.storageFlags?.actions===false?{ok:value.ok,evidenceOmitted:true}:sdkEvidence(value,64_000_000);
        await archive({action:"sdk.operation",phase:"finished",...entry,result:evidence,durationMs:Date.now()-start});
        historyQueue=historyQueue.then(()=>deps.contextHistory?.append({...entry,layer:"gateway",args:argumentsEvidence,result:evidence}));
        await historyQueue;
        return value;
      },{signal,wallClockMs:args.timeoutMs,maxCalls:1000,input:deps.input,helpers,workspace:deps.workspace,compiled:deps.compiled,invocationId,
        onOutput:async output=>{if(deps.storageFlags?.actions!==false&&!sensitiveInvocation)await deps.workspace?.saveOutput(invocationId,output);}}).finally(async()=>{await deps.session.page.proxy!({command:"close"},{invocation:invocationId}).catch(()=>undefined);});
      await stateQueue;
      await archive({action:"sdk.invocation",invocationId,evidenceScope:deps.evidenceScope,language:"python",operationVersion:3,apiVersion:PLAYWRIGHT_API_VERSION,source:deps.storageFlags?.actions===false||sensitiveInvocation?undefined:args.source,
        workspaceBefore:sensitiveInvocation?undefined:workspaceBefore,evidenceOmitted:deps.storageFlags?.actions===false||sensitiveInvocation,input:sensitiveInvocation?undefined:sdkEvidence(deps.input),helpers:sensitiveInvocation?[]:helpers,api:[...registry.entries()].filter(([name])=>name.startsWith("workflow.")).map(([name,t])=>({name,parameters:asSchema(t.parameters).jsonSchema})),
        outcome:terminal?.outcome??result.outcome,compiled:deps.compiled===true,calls:result.calls});
      if(fatal)throw fatal;
      if(terminal&&result.outcome==="completed")return {ok:true,value:{outcome:terminal.outcome},terminal,images};
      if(deps.compiled&&(terminal?.outcome==="deopt"||result.outcome!=="completed"))return {ok:true,value:{outcome:"deopt"},terminal:terminal??{outcome:"deopt",reason:result.outcome==="completed"?"No completion":result.error},images};
      if(result.outcome==="killed")throw new AppError("resource_limit_exceeded",result.error);
      return result.outcome==="completed"?{ok:true,value:yielded?{outcome:"yielded"}:{...obj(result.value),invocationId},images}:{ok:false,error:result.error,value:{invocationId},images};
    }});
}

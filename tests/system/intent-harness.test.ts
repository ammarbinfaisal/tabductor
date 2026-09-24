import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDispatcher } from "@tabductor/bus";
import { destinationContracts, destinationRecords, events, runs, workflowExecutions } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { createEngine, createWorkflow, graphSchema, publishVersion, readGraph, staticSchemaGenerator, triggerTask, recordProgress,
  type Engine, type ExecutorRegistry } from "@tabductor/engine";
import { bindIntent } from "../../packages/engine/src/intent-contract.js";

let db: MigratedTestDb, engine: Engine | undefined, dispatcher: ReturnType<typeof createDispatcher> | undefined;
beforeEach(async () => { db = await createMigratedTestDb(); });
afterEach(async () => { await dispatcher?.stop(); await engine?.stop(); await db?.close(); dispatcher = undefined; engine = undefined; });
async function start(executors: ExecutorRegistry) {
  dispatcher = createDispatcher(db); engine = createEngine({ db: db.db, dispatcher, executors, scheduler: false, watchdogIntervalMs: 20 });
  await engine.start(); await dispatcher.start();
}
async function settled(executionId: string) {
  await vi.waitFor(async () => {
    const [row] = await db.db.select().from(workflowExecutions).where(eq(workflowExecutions.id, executionId));
    expect(row?.status).toBe("succeeded");
  }, { timeout: 6000 });
}

it.each([undefined, "prepare-destination", "source", "write-record"])("runs an entire browser task without role prerequisites (%s)", async role => {
  const request = "Read the website and update its settings";
  const workflowId = await createWorkflow(db.db, {name:"Browser automation",userId:"local"});
  const draft = graphSchema.parse({automationPrompt:request,intent:bindIntent(request,{requirements:[{id:"work",description:request,quote:request}]}),
    tasks:[{name:"Browse",kind:"browser",mode:"ai",entry:true,limits:{harness:{version:1,requirementIds:["work"],role,
      destination:{url:"https://example.test",setupTask:"missing",readyEvent:"destination.ready"}}}}]});
  const published = await publishVersion(db.db,{workflowId,graph:draft},{schemaGenerator:staticSchemaGenerator()});
  expect((await readGraph(db.db,published.versionId)).tasks[0]!.limits.harness).toEqual({version:1,requirementIds:["work"]});
  // Old published task rows may still carry the retired metadata. Runtime must ignore it too.
  const {tasks} = await import("@tabductor/db");
  await db.db.update(tasks).set({limitsJson:{harness:{version:1,requirementIds:["work"],role,destination:{url:"https://example.test"}}}})
    .where(eq(tasks.id,published.taskIds.Browse!));
  let calls = 0;
  await start({"browser:ai":{async execute(handle) {
    calls++; expect(handle).not.toHaveProperty("destination");
    expect(await handle.recordCompletionError!()).toBeNull();
    return {ok:true};
  }}});
  const triggered = await triggerTask(db.db,{taskId:published.taskIds.Browse!});
  await settled(triggered.event.executionId!);
  expect(calls).toBe(1);
  expect(await db.db.select().from(destinationContracts)).toHaveLength(0);
  expect(await db.db.select().from(destinationRecords)).toHaveLength(0);
});

it("routes ordinary browser handoffs without injecting fields or requiring record outcomes", async () => {
  const workflowId = await createWorkflow(db.db,{name:"Handoff",userId:"local"});
  const draft = graphSchema.parse({tasks:[
    {name:"Browse",entry:true,kind:"browser",mode:"ai",emits:["destination.ready"]},
    {name:"Continue",entry:false,kind:"browser",mode:"ai",consumes:["destination.ready"]},
    {name:"Assess",entry:false,kind:"decision",mode:"ai",consumes:["destination.ready"]},
  ],events:[{type:"destination.ready",description:"Observed title"}]});
  const published=await publishVersion(db.db,{workflowId,graph:draft},{schemaGenerator:staticSchemaGenerator({
    "destination.ready":{type:"object",properties:{title:{type:"string"}},required:["title"],additionalProperties:false},
  })});
  const seen:string[]=[];
  const execute: ExecutorRegistry[string]["execute"] = async handle => {
    seen.push(handle.task.name);
    if(handle.task.name==="Browse") {
      expect(await handle.declaredEmits()).toHaveLength(1);
      await handle.emit("destination.ready",{title:"Observed"});
    } else {
      expect(handle.trigger!.packet).toEqual({title:"Observed"});
      expect(handle.recordInput).toBeUndefined();
      expect(await handle.recordCompletionError!()).toBeNull();
    }
    return {ok:true};
  };
  await start({"browser:ai":{execute},"decision:ai":{execute}});
  const triggered=await triggerTask(db.db,{taskId:published.taskIds.Browse!});
  await settled(triggered.event.executionId!);
  expect(seen.sort()).toEqual(["Assess","Browse","Continue"]);
  expect(await db.db.select().from(events).where(eq(events.type,"destination.ready"))).toHaveLength(1);
});

it.each(["readback", "ai-assessment"] as const)("retains optional record normalization and %s accounting without mappings", async method => {
  const workflowId = await createWorkflow(db.db,{name:"Tracked browser work",userId:"local"});
  const draft=graphSchema.parse({tasks:[
    {name:"Find",entry:true,kind:"browser",mode:"ai",emits:["item"],limits:{recordProcessing:{version:1,eventType:"item",identityField:"id",contentFields:["body"]}}},
    {name:"Act",entry:false,kind:"browser",mode:"ai",consumes:["item"]},
  ],events:[{type:"item",description:"One item",record:{collection:"items",key:"id",status:"pending"}}]});
  const published=await publishVersion(db.db,{workflowId,graph:draft},{schemaGenerator:staticSchemaGenerator({
    item:{type:"object",properties:{id:{type:"string"},body:{type:"string"}},required:["id","body"],additionalProperties:false},
  })});
  await start({"browser:ai":{async execute(handle) {
    if(handle.task.name==="Find") {
      expect(await handle.emit("item",{body:"content"})).not.toBeNull();
      expect(await handle.emit("item",{body:"content"})).toBeNull();
    } else {
      expect(handle.recordInput).toMatchObject({key:"id",packet:{id:expect.stringMatching(/^content:/),body:"content"}});
      await handle.recordOutcome!({status:"saved",reason:"Observed saved content",verification:{method,
        ...(method==="readback"?{snapshotId:"observed"}:{assessmentId:"assessed"}),url:"https://example.test",checkedAt:new Date().toISOString(),
        recordKey:String(handle.recordInput!.packet.id)}});
    }
    return {ok:true};
  }}});
  const triggered=await triggerTask(db.db,{taskId:published.taskIds.Find!});
  await settled(triggered.event.executionId!);
  expect(await recordProgress(db.db,triggered.event.executionId!)).toMatchObject({total:1,saved:1,
    verifiedSaved:method==="readback"?1:0,aiAssessedSaved:method==="ai-assessment"?1:0});
});

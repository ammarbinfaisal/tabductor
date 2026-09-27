import { afterEach, expect, it } from "vitest";
import { browserHelpers } from "@tabductor/db";
import { triggerTask, type RunHandle } from "@tabductor/engine";
import { seedWorkflow } from "@tabductor/engine/testing";
import { browserHelperStore } from "../../packages/agent/src/browser-helpers.js";
import { startRig, waitForQuiet, runsForTask, type Rig } from "./engine-support.js";

let rig: Rig | undefined;
afterEach(async()=>{await rig?.stop();rig=undefined;});

it("persists immutable task helpers across runs and fences other definitions and expired leases",async()=>{
  let previous: RunHandle | undefined, pass=0;
  const first="export default async (api,args) => args.value";
  const second="export default async (api,args) => ({value:args.value})";
  rig=await startRig({executors:{"browser:ai":{async execute(handle){
    const helpers=browserHelperStore(rig!.handle.db,handle);
    if(pass++===0){
      expect(await helpers.list()).toEqual([]);
      await helpers.define("observe",first);
      await helpers.define("observe",first);
      previous=handle;
    }else{
      expect(await helpers.list()).toMatchObject([{name:"observe",source:first}]);
      await helpers.define("observe",second);
      expect(await helpers.list()).toMatchObject([{source:second}]);
      const changed=browserHelperStore(rig!.handle.db,{...handle,task:{...handle.task,contentHash:"changed"}});
      const otherTask=browserHelperStore(rig!.handle.db,{...handle,task:{...handle.task,name:"another"}});
      expect(await changed.list()).toEqual([]);
      expect(await otherTask.list()).toEqual([]);
      await expect(browserHelperStore(rig!.handle.db,previous!).define("stale",first)).rejects.toThrow();
    }
    return {ok:true};
  }}}});
  const wf=await seedWorkflow(rig.handle.db,{tasks:{Browser:{mode:"ai",retry:{max:0}}}});
  await triggerTask(rig.handle.db,{taskId:wf.taskIds.Browser!});await waitForQuiet(rig);
  await triggerTask(rig.handle.db,{taskId:wf.taskIds.Browser!});await waitForQuiet(rig);
  expect(pass).toBe(2);
  expect((await runsForTask(rig,wf.taskIds.Browser!)).map(r=>r.status)).toEqual(["succeeded","succeeded"]);
  expect(await rig.handle.db.select().from(browserHelpers)).toHaveLength(2);
});

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchChrome, type Chrome } from "@tabductor/testkit";
import { openRunSession, playwrightDriver, type BrowserConn, type RunSession } from "@tabductor/browser";
import { AllowAllGate } from "@tabductor/policy";
import { buildToolRegistry } from "../../packages/agent/src/tools.js";
import { runAgentLoop } from "../../packages/agent/src/loop.js";
import { summarizePerception } from "../../packages/agent/src/tools.js";

let chrome:Chrome,conn:BrowserConn,server:Server,origin:string;
const trace={record:async()=>{},flush:async()=>{},close:async()=>{}};
beforeAll(async()=>{
  const html=readFileSync(new URL("../../apps/browser-worker/tests/fixtures/perception.html",import.meta.url));
  const propertyEditor=readFileSync(new URL("../../apps/browser-worker/tests/fixtures/property-editor.html",import.meta.url));
  const editor = `<nav>${Array.from({length: 450}, (_, i) => `<button>Sidebar ${i}</button>`).join("")}</nav>
    <main><div>record-42</div><div id="saved"></div><button id="open">Edit body</button></main>
    <script>document.querySelector('#open').onclick=()=>{const portal=document.createElement('div');portal.setAttribute('role','dialog');portal.style='position:fixed;top:20px;left:20px;background:white';
    portal.innerHTML='<div contenteditable="true" style="min-width:200px;min-height:30px" data-placeholder="" data-content-editable-placeholder="Write a value"></div>';document.body.append(portal);const field=portal.firstChild;field.focus();
    field.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();document.querySelector('#saved').textContent=field.textContent;portal.remove();}if(e.key==='Escape')portal.remove();};};</script>`;
  server=createServer((req,res)=>{res.setHeader("Content-Type","text/html");res.end(req.url==="/popup"?"<h1>Owned popup</h1>":req.url==="/editor"?editor:req.url==="/property-editor"?propertyEditor:html);});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  chrome=await launchChrome();conn=await playwrightDriver.connect(chrome.wsUrl);
});
afterAll(async()=>{await conn?.close();await chrome?.close();await new Promise<void>(r=>server?.close(()=>r()));});
async function setup(){
  const session=await openRunSession({conn,trace,taskCtx:{taskId:"t",runId:"r"},gate:new AllowAllGate({navAllowlist:["127.0.0.1"]})});
  await session.page.goto(origin);const tools=new Map(buildToolRegistry({session,emit:async()=>({outcome:"deduped"})}).map(t=>[t.name,t]));
  return {session,tools,call:(name:string,args:unknown={})=>tools.get(name)!.execute(args)};
}
async function anchor(session:RunSession,query:string){const p=await session.page.perceive({query,elementLimit:100});const e=p.elements.find(e=>e.name===query||e.text===query);expect(e).toBeDefined();return e!.anchor;}

it("brings a recreated portal editor ahead of a dense sidebar and excludes its draft from save evidence", async () => {
  const { session } = await setup();
  try {
    await session.page.goto(`${origin}/editor`);
    await session.page.click("#open");
    const p = await session.page.perceive({ elementLimit: 10 });
    expect(p.elements[0]).toMatchObject({ name: "Write a value", role: "textbox", focused: true, value: "" });
    expect(p.coverage?.totalElements).toBeGreaterThan(450);
    const tools = new Map(buildToolRegistry({ session, emit: async () => ({ outcome: "deduped" }),
      verificationContext: { packet: { id: "record-42", body: "required body" }, mapping: { id: "contract", revision: 1, destinationKey: `${origin}/editor`, canonicalUrl: `${origin}/editor`, fields: [], identityField: "id", verificationFields: ["id", "body"], dedupe: "search-before-create" } },
    }).map(t => [t.name, t]));
    const typed = await tools.get("page.type")!.execute({ anchor: p.elements[0]!.anchor, text: "required body" });
    expect(typed.ok, JSON.stringify(typed)).toBe(true);
    const draft = await session.page.perceive({ elementLimit: 10 });
    expect(draft.elements[0]?.value).toBe("required body");
    expect(draft.committedText).not.toContain("required body");
    expect(tools.has("page.verify")).toBe(false);
    expect(await tools.get("page.press")!.execute({ key: "Enter" })).toMatchObject({ ok: true });
    expect((await session.page.perceive()).committedText).toContain("required body");
  } finally { await session.close(); }
});

it("accepts the advertised main frame in perception, search and scoped inspection", async () => {
  const { session, call } = await setup();
  try {
    const initial = await session.page.perceive({ elementLimit: 100 });
    const frameId = initial.elements.find(e => e.tag === "article")!.frameId;
    expect(frameId).toBe("main");
    expect(initial.frames?.some(frame => frame.id === frameId)).toBe(false);
    expect(await call("page.perceive", { frameId })).toMatchObject({ ok: true });
    const found = await call("page.find", { frameId, query: "Control 449" });
    expect(found.ok).toBe(true);
    expect(JSON.stringify(found)).toContain("Control 449");
    const fresh = await session.page.perceive({ frameId, elementLimit: 100 });
    const article = fresh.elements.find(e => e.tag === "article")!;
    const scoped = await call("page.inspect", { frameId: article.frameId, anchor: article.anchor });
    expect(scoped.ok).toBe(true);
    expect(JSON.stringify(scoped)).toContain("span.author");
    await expect(session.page.perceive({ frameId: "missing-frame" })).rejects.toThrow("frame unavailable");
  } finally { await session.close(); }
});

it("offers semantic state, scoped field hints, open shadow roots and explicit frame inspection",async()=>{
  const {session,call}=await setup();try{
    const p=await session.page.perceive({elementLimit:100});
    expect(p.elements.find(e=>e.name==="Account name")).toMatchObject({role:"textbox",value:"before",inputType:"text"});
    expect(p.elements.find(e=>e.name==="Enabled")).toMatchObject({checked:true});
    expect(p.elements.find(e=>e.name==="Unavailable")).toMatchObject({disabled:true});
    expect(p.elements.find(e=>e.tag==="option"&&e.text==="Beta")).toMatchObject({role:"option",value:"b",selected:false});
    expect(p.elements.some(e=>e.name==="Shadow control")).toBe(true);
    expect(p.elements.some(e=>e.text?.includes("Hidden skip")&&e.tag==="a")).toBe(false);
    expect(p.elements.some(e=>e.text==="Hidden ancestor")).toBe(false);
    expect(JSON.stringify(p)).not.toContain("never-observe-this");
    const article=p.elements.find(e=>e.tag==="article")!;
    const inspected=await call("page.inspect",{anchor:article.anchor});
    expect(JSON.stringify(inspected)).toContain("span.author");
    const whole=await session.page.perceive({elementLimit:100});
    const root=whole.elements.find(e=>e.tag==="main")!;
    const firstSlice=await call("page.inspect",{anchor:root.anchor,elementLimit:5});
    const scope1=(firstSlice.value as {scopeAnchor:string}).scopeAnchor;
    const secondSlice=await call("page.inspect",{anchor:scope1,elementOffset:5,elementLimit:5});
    const scope2=(secondSlice.value as {scopeAnchor:string}).scopeAnchor;
    expect(session.resolveAnchor(scope2)).toBeDefined();
    expect(await call("page.inspect",{anchor:scope2,elementOffset:10,elementLimit:5})).toMatchObject({ok:true});
    const frame=await session.page.perceive({frameId:p.frames![0]!.id});
    expect(frame.elements.find(e=>e.name==="Frame name")).toMatchObject({role:"textbox",frameId:p.frames![0]!.id});
    const field=frame.elements.find(e=>e.name==="Frame name")!;
    await session.page.type(session.resolveAnchor(field.anchor)!,"inside frame");
    expect((await session.page.perceive({frameId:p.frames![0]!.id})).elements.find(e=>e.name==="Frame name")?.value).toBe("inside frame");
  }finally{await session.close();}
});

it("paginates beyond the old element and text caps without dropping successful observations",async()=>{
  const {session,call}=await setup();try{
    const first=await call("page.perceive",{maxChars:20000,elementLimit:100});expect(first.ok).toBe(true);
    const value=first.value as Record<string,unknown>;expect(String(value.text).length).toBe(20000);
    expect(JSON.stringify(first).length).toBeLessThan(32000);
    const found=await call("page.find",{query:"Control 449"});expect(JSON.stringify(found)).toContain("Control 449");
    let offset=0;const seen=new Set<string>();
    do {const p=await session.page.perceive({elementOffset:offset,elementLimit:100});const summary=summarizePerception(p);
      for(const e of summary.elements as Array<{text?:string;name?:string}>)seen.add(e.text ?? e.name ?? "");
      offset=summary.nextElementOffset as number;
    }while(offset!==null);
    expect(seen.has("Control 449")).toBe(true);
    const tail=await call("page.perceive",{textOffset:30000,maxChars:20000});expect(JSON.stringify(tail)).toContain("Tail sentinel");
  }finally{await session.close();}
});

it("rejects old anchors instead of retargeting a queued action after DOM insertion",async()=>{
  const {session,tools}=await setup();try{
    const p=await session.page.perceive({elementLimit:100});
    const insert=p.elements.find(e=>e.text==="Insert")!,save=p.elements.find(e=>e.text==="Save")!;
    let step=0;
    const cancel = new AbortController();
    const result = await runAgentLoop({llm:{complete:async()=>{
      if(step++ > 0) cancel.abort();
      return {usage:{in:1,out:1},toolCalls:[
        {id:"insert",name:"page.click",args:{anchor:insert.anchor}},{id:"save",name:"page.click",args:{anchor:save.anchor}}]};
    }},tools:[...tools.values()],task:{prompt:"fixture"},trigger:null,emits:[],trace,signal:cancel.signal});
    expect(result).toEqual({outcome:"fail",reason:"run_cancelled"});
    expect(await session.page.queryAll("#status",{text:{}})).toEqual([{text:"Not saved"}]);
    expect(session.resolveAnchor(save.anchor)).toBeUndefined();
    await tools.get("page.click")!.execute({anchor:await anchor(session,"Save")});
    expect(await session.page.queryAll("#status",{text:{}})).toEqual([{text:"Saved successfully"}]);
  }finally{await session.close();}
});

it("refuses a replacement node that copies an observed node's identity attribute",async()=>{
  const {session}=await setup();try{
    const p=await session.page.perceive({elementLimit:100});
    const saved=p.elements.find(e=>e.text==="Save")!;
    const locator=session.resolveAnchor(saved.anchor)!;
    await session.page.click("#clone");
    await expect(session.page.click(locator)).rejects.toThrow("replaced");
    expect(await session.page.queryAll("#status",{text:{}})).toEqual([{text:"Not saved"}]);
  }finally{await session.close();}
});

it("verifies outcomes, delivers image bytes, selects options and accepts an armed dialog",async()=>{
  const {session,call}=await setup();try{
    expect(await call("done")).toMatchObject({ok:true});
    expect((await session.page.perceive()).text).not.toContain("Saved successfully");
    await call("page.click",{anchor:await anchor(session,"Save")});
    expect((await session.page.perceive()).text).toContain("Saved successfully");
    expect(await call("done")).toMatchObject({ok:true});
    await call("page.select",{anchor:await anchor(session,"Choice"),values:["b"]});
    expect(await call("done")).toMatchObject({ok:true});
    expect(await call("page.click",{anchor:"expired"})).toMatchObject({ok:false});
    expect((await session.page.perceive({query:"Choice"})).elements.find(e=>e.name==="Choice")?.value).toBe("b");
    expect(await call("done")).toMatchObject({ok:true});
    const shot=await call("page.screenshot",{anchor:await anchor(session,"Save")});
    expect(shot.images?.[0]?.mime).toBe("image/png");expect(shot.images?.[0]?.data.length).toBeGreaterThan(100);
    await call("page.dialog",{accept:true});await call("page.click",{anchor:await anchor(session,"Confirm")});
    expect((await session.page.perceive()).text).toContain("Confirmed");
  }finally{await session.close();}
});

it("presses keys, hovers, drags and scrolls a selected container",async()=>{
  const {session,call}=await setup();try{
    await call("page.press",{anchor:await anchor(session,"Account name"),key:"Enter"});
    expect((await session.page.perceive()).text).toContain("Pressed");
    await call("page.hover",{anchor:await anchor(session,"Hover target")});
    expect((await session.page.perceive()).text).toContain("Hovered");
    const p=await session.page.perceive({elementLimit:100});
    const source=p.elements.find(e=>e.name==="Drag source")!,target=p.elements.find(e=>e.name==="Drop target")!;
    expect(await call("page.drag",{anchor:source.anchor,targetAnchor:target.anchor})).toMatchObject({ok:true});
    expect((await session.page.perceive()).text).toContain("Dropped");
    expect(await call("page.scroll",{anchor:await anchor(session,"Scroll region"),direction:"down"})).toMatchObject({ok:true});
    await session.page.waitFor('#scroll-box[data-scrolled="yes"]');
  }finally{await session.close();}
});

it("keeps download bytes out of history and exposes only owned popup tabs",async()=>{
  const a=await setup(),b=await setup();try{
    const file=await a.call("page.download",{anchor:await anchor(a.session,"Download")});expect(file.ok).toBe(true);
    expect(JSON.stringify(file)).not.toContain("downloaded-content");
    const id=(file.value as {fileId:string}).fileId;
    expect(await a.call("file.read",{fileId:id})).toMatchObject({ok:true,value:{text:"downloaded-content"}});
    await a.call("page.upload",{anchor:await anchor(a.session,"Upload"),fileId:id});
    await a.call("page.click",{anchor:await anchor(a.session,"Popup")});
    let tabs=await a.session.page.tabs!();
    for(let i=0;i<20&&tabs.length<2;i++){await new Promise(r=>setTimeout(r,50));tabs=await a.session.page.tabs!();}
    expect(tabs).toHaveLength(2);expect(tabs.some(t=>t.id===b.session.page.id)).toBe(false);
    expect(await a.call("tabs.switch",{id:b.session.page.id})).toMatchObject({ok:false});
    const popup=tabs.find(t=>t.url.includes("/popup"))!;expect(popup).toBeDefined();
    expect(await a.call("tabs.switch",{id:popup.id})).toMatchObject({ok:true});
  }finally{await a.session.close();await b.session.close();}
});

it("settles delayed property editors, keeps summaries across cycles, and verifies only explicit assertions", async () => {
  const {session} = await setup();
  let history: unknown = [];
  const actions = {get:async()=>history,set:async(value:unknown)=>{history=structuredClone(value);}};
  const tools = new Map(buildToolRegistry({session,actions,emit:async()=>({outcome:"deduped"})}).map(t=>[t.name,t]));
  const call = (name:string,args:unknown={}) => tools.get(name)!.execute(args);
  try {
    await session.page.goto(`${origin}/property-editor`);
    for (let i=0;i<3;i++) {
      const opened = await call("page.click",{anchor:await anchor(session,"Add property")});
      expect(opened).toMatchObject({ok:true,action:{target:{name:"Add property"},changes:expect.arrayContaining(["dialog_opened"])},observation:{stability:"settled",activeScope:"dialog"}});
      const p = session.lastPerception!()!;
      expect(p.elements[0]).toMatchObject({role:"textbox",focused:true,controlLabel:"Property name"});
      expect(opened.action?.controls).toEqual(expect.arrayContaining([expect.objectContaining({role:"textbox",name:"Property name"})]));
      const closed = await call("page.press",{anchor:p.elements[0]!.anchor,key:"Escape"});
      expect(closed).toMatchObject({action:{operation:"Escape",target:{name:"Property name"},changes:expect.arrayContaining(["dialog_closed"])}});
    }
    const rejected = await call("page.click",{anchor:await anchor(session,"Add property")});
    expect(rejected).toMatchObject({ok:false,action:{dispatch:"rejected"},recovery:{reason:"cycle",repetitions:3,cycle:expect.arrayContaining([expect.objectContaining({operation:"Escape"})])}});
    expect(session.lastPerception!()!.activeScope).toBe("page");
    expect(await call("memory.get")).toMatchObject({value:{actions:expect.arrayContaining([expect.objectContaining({target:expect.objectContaining({name:"Add property"})})])}});
    // Further reads do not reset the cycle detector or allow another identical click.
    await call("page.find",{role:"button",query:"Add property"});
    expect(await call("page.click",{anchor:session.lastPerception!()!.elements.find(e=>e.name==="Add property")!.anchor})).toMatchObject({ok:false,recovery:{reason:"cycle",rejectedAttempts:2}});
    await expect(call("page.click",{anchor:await anchor(session,"Add property")})).rejects.toThrow('Historical page labels');
  } finally {await session.close();}
});

it("filters inspection wrappers while retaining structural detail and pagination on demand", async () => {
  const {session,call} = await setup();
  try {
    await session.page.goto(`${origin}/property-editor`);
    await call("page.click",{anchor:await anchor(session,"Add property")});
    const dialog = session.lastPerception!()!.elements.find(e=>e.role==="dialog")!;
    const inspected = await call("page.inspect",{anchor:dialog.anchor,elementLimit:10});
    const p=inspected.value as {elements:Array<{role:string;anchor:string}>;totalElements:number;scopeAnchor:string};
    expect(p.elements[0]?.role).toBe("textbox");
    expect(p.totalElements).toBeLessThan(15);
    const structural=await call("page.inspect",{anchor:p.scopeAnchor,structuralDetail:true,elementLimit:10});
    expect(structural.value).toMatchObject({totalElements:expect.any(Number),nextElementOffset:10});
    expect((structural.value as {totalElements:number}).totalElements).toBeGreaterThan(350);
    const root=(structural.value as {scopeAnchor:string}).scopeAnchor;
    expect(await call("page.inspect",{anchor:root,structuralDetail:true,elementLimit:10,elementOffset:10})).toMatchObject({ok:true,value:{elementOffset:10}});
    const input=await anchor(session,"Property name");
    expect(await call("page.type",{anchor:input,text:"username"})).toMatchObject({ok:true,action:{changes:expect.arrayContaining(["field_state_changed"])}});
    expect(await call("page.press",{key:"Enter"})).toMatchObject({ok:true,action:{dispatch:"executed"}});
    expect((await session.page.perceive()).text).toContain("username");
  } finally {await session.close();}
});

import { z } from "zod";
import { AppError } from "@tabductor/core";
import type { RunSession } from "@tabductor/browser";
import { defineTool, type AgentTool } from "./tools.js";
import { browserJavascript } from "./browser-javascript.js";

const frame = { frameUrl: z.string().optional(), timeoutMs: z.number().int().min(1).max(120000).optional() };
const selector = { selector: z.string().min(1), ...frame };
/** One operation vocabulary for the Python facade and compiled JavaScript. */
export function harnessTools(session: RunSession): AgentTool[] {
  if (!session.page.harness) return [];
  const methods = {
    current_tab: z.object({}), new_tab: z.object({}), page_info: z.object({}),
    accessibility_tree: z.object({ selector: z.string().default("body"), ...frame }),
    clipboard_write: z.object({ text: z.string() }), paste: z.object({ text: z.string().optional() }),
    request: z.object({ url: z.string(), method: z.string().default("GET"), body: z.unknown().optional(), headers: z.record(z.string()).default({}), semantics: z.enum(["read", "write"]).default("write"), ...frame }),
    observe: z.object({ selector: z.string().optional(), ...frame }),
    extract: z.object({selector:z.string().min(1),fields:z.record(z.object({selector:z.string().optional(),attr:z.string().optional()})),limit:z.number().int().min(1).max(100).default(50)}),
    find: z.object({ ...selector, limit: z.number().int().min(1).max(100).optional() }),
    click: z.object(selector),
    fill: z.object({ ...selector, text: z.string() }),
    js: z.object({ expression: z.string().max(24000), argument: z.unknown().optional(), ...frame }),
    click_at_xy: z.object({ x: z.number(), y: z.number(), button: z.enum(["left","right","middle"]).optional(), clicks: z.number().int().min(1).max(3).optional() }),
    type_text: z.object({ text: z.string() }),
    press_key: z.object({ key: z.string(), modifiers: z.number().int().min(0).max(15).default(0) }),
    scroll: z.object({ x:z.number().optional(), y:z.number().optional(), dx:z.number().optional(), dy:z.number().optional() }),
    wait_for_element: z.object({ ...selector, state:z.enum(["attached","detached","visible","hidden"]).optional() }),
    frames: z.object({}), screenshot: z.object({}),
    upload: z.object({ ...selector, name:z.string().max(255), mimeType:z.string().optional(), base64:z.string().max(8_000_000) }),
    download: z.object(selector),
  };
  const tools: AgentTool[] = Object.entries(methods).map(([name, parameters]) => defineTool({ name:`harness.${name}`, parameters,
    description: name === "extract" ? "Read a list of records using selector and fields={field:{selector?,attr?}}. Fields are relative to each record; omit selector for the record itself and attr for text. Missing fields return null. Read-only; invalid selectors can be corrected without an uncertain-write fence." :
      name === "js" ? "Evaluate browser JavaScript (expression, statements, function or promise) with an optional argument. Bind dynamic values through argument. Syntax errors are rejected before execution. Prefer extract for routine DOM reads; inspect unknown effects before deciding whether to repeat them." :
      `Camoufox ${name}. Selectors are resolved on the current page/frame, not historical snapshot anchors. Inspect the page after mutations.`,
    async execute(args) {
      try {
        if (name === "current_tab") return {ok:true,value:{id:session.page.id,targetId:session.page.id,target_id:session.page.id,url:session.page.url(),title:await session.page.title()}};
        if (name === "extract") {
          const input = args as {selector:string;fields:Record<string,{selector?:string;attr?:string}>;limit:number};
          return {ok:true,value:await session.page.queryAll(input.selector,input.fields,{limit:input.limit})};
        }
        const value = await session.page.harness!(name, name === "js" ? {...args,expression:browserJavascript(String((args as {expression:string}).expression))} : args);
        if (name === "request" && (value as {ok:boolean}).ok === false) return {ok:false,error:`Browser request returned HTTP ${(value as {status:number}).status}`,value,outcomeUncertain:(args as {semantics?:string}).semantics !== "read"};
        if (name === "screenshot") return {ok:true,value:{captured:true},images:[{data:String((value as {base64:string}).base64),mime:"image/png"}]};
        return {ok:true,value};
      } catch(error) {
        if (error instanceof AppError && ["browser_input_revoked","browser_fresh_perception_required","browser.disconnected"].includes(error.code)) throw error;
        return {ok:false,error:String(error),...(error instanceof AppError ? {code:error.code} : {}),outcomeUncertain:!(error instanceof AppError && error.details?.outcomeUncertain === false)};
      }
    } }));
  return tools;
}

import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { liveLlm } from "./llm-live.js";

afterEach(()=>vi.unstubAllGlobals());
it("sends image tool results and preserved call IDs through the OpenAI adapter",async()=>{
  let body:Record<string,unknown>|undefined;
  vi.stubGlobal("fetch",vi.fn(async(_url,init:RequestInit)=>{
    body=JSON.parse(String(init.body));
    return new Response(JSON.stringify({id:"resp_test",object:"response",created_at:0,model:"fixture-model",status:"completed",
      output:[{id:"msg_test",type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:"seen",annotations:[]}]}],
      usage:{input_tokens:10,output_tokens:1,total_tokens:11}}),{headers:{"content-type":"application/json"}});
  }));
  const result=await liveLlm({provider:"openai",apiKey:"fixture-key",model:"fixture-model"}).complete({system:"inspect",
    tools:[{name:"page.screenshot",description:"see",parameters:z.object({})}],messages:[{role:"user",content:"Look"},
      {role:"assistant",content:"",toolCalls:[{id:"call_image",name:"page.screenshot",args:{}}]},
      {role:"tool",content:"",toolResults:[{id:"call_image",name:"page.screenshot",result:{ok:true,value:{},images:[{mime:"image/png",data:"iVBORw0KGgo="}]}}]}]});
  expect(result.text).toBe("seen");
  const input=body!.input as Array<Record<string,unknown>>;
  expect(input).toEqual(expect.arrayContaining([expect.objectContaining({type:"function_call",call_id:"call_image",name:"page__screenshot"}),
    expect.objectContaining({type:"function_call_output",call_id:"call_image",output:expect.arrayContaining([expect.objectContaining({type:"input_image",image_url:"data:image/png;base64,iVBORw0KGgo="})])})]));
});

it("sends image tool results and preserved call IDs through the Anthropic adapter",async()=>{
  let body:Record<string,unknown>|undefined;
  vi.stubGlobal("fetch",vi.fn(async(_url,init:RequestInit)=>{
    body=JSON.parse(String(init.body));
    return new Response(JSON.stringify({id:"msg_test",type:"message",role:"assistant",model:"fixture-model",
      content:[{type:"text",text:"seen"}],stop_reason:"end_turn",stop_sequence:null,usage:{input_tokens:10,output_tokens:1}}),
      {headers:{"content-type":"application/json"}});
  }));
  const result=await liveLlm({provider:"anthropic",apiKey:"fixture-key",model:"fixture-model"}).complete({system:"inspect",
    tools:[{name:"page.screenshot",description:"see",parameters:z.object({})}],messages:[{role:"user",content:"Look"},
      {role:"assistant",content:"",toolCalls:[{id:"call_image",name:"page.screenshot",args:{}}]},
      {role:"tool",content:"",toolResults:[{id:"call_image",name:"page.screenshot",result:{ok:true,value:{},images:[{mime:"image/png",data:"iVBORw0KGgo="}]}}]}]});
  expect(result.text).toBe("seen");
  const messages=body!.messages as Array<{content:unknown[]}>;
  expect(messages.flatMap(m=>m.content)).toEqual(expect.arrayContaining([
    expect.objectContaining({type:"tool_use",id:"call_image",name:"page__screenshot"}),
    expect.objectContaining({type:"tool_result",tool_use_id:"call_image",content:expect.arrayContaining([
      expect.objectContaining({type:"image",source:{type:"base64",media_type:"image/png",data:"iVBORw0KGgo="}})])})]));
});

import { expect, it, vi } from "vitest";
import { createCaptchaProviders, captchaCreateSchema } from "./captcha-providers.js";

it.each(["2captcha", "capsolver", "anti-captcha"] as const)("passes native %s task fields through and preserves non-token solutions", async name => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({errorId:0,taskId:name==="capsolver"?"uuid-task":123}))
    .mockResolvedValueOnce(Response.json({errorId:0,status:"ready",solution:{coordinates:[{x:10,y:20}],text:"answer",cookies:{challenge:"cookie"}}}));
  const provider = createCaptchaProviders({keys:{[name]:"private-key"},rates:[],fetch:fetcher}).find(p=>p.name===name)!;
  const task = {type:"FutureProviderTask",custom:{nested:true},body:"base64",proxyPassword:"private-proxy"};
  const submitted = await provider.submit({provider:name,task,idempotency_key:"one"});
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({clientKey:"private-key",task});
  expect(fetcher.mock.calls[0]![1]!.redirect).toBe("error");
  expect(await provider.poll(submitted.taskId!)).toMatchObject({status:"ready",solution:{coordinates:[{x:10,y:20}],text:"answer",cookies:{challenge:"cookie"}}});
  expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body)).taskId).toBe(name==="capsolver"?"uuid-task":123);
});

it("accepts an immediate CapSolver solution without polling or requiring a task id", async () => {
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(Response.json({errorId:0,status:"ready",solution:{text:"recognized"}}));
  const provider=createCaptchaProviders({keys:{capsolver:"key"},rates:[],fetch:fetcher})[0]!;
  expect(await provider.submit({provider:"capsolver",task:{type:"ImageToTextTask",body:"image"},idempotency_key:"x"})).toEqual({status:"ready",taskId:undefined,solution:{text:"recognized"}});
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("returns sanitized provider error codes and never propagates credentials or raw HTTP errors", async () => {
  const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({errorId:1,errorCode:"ERROR_ZERO_BALANCE",errorDescription:"secret-key"}))
    .mockRejectedValueOnce(new Error("request included secret-key"));
  const provider=createCaptchaProviders({keys:{capsolver:"secret-key"},rates:[],fetch:fetcher})[0]!;
  const args={provider:"capsolver" as const,task:{type:"SomeTask"},idempotency_key:"x"};
  expect(await provider.submit(args)).toMatchObject({status:"failed",errorCode:"ERROR_ZERO_BALANCE"});
  await expect(provider.submit(args)).rejects.toMatchObject({code:"captcha_transport_uncertain",message:expect.not.stringContaining("secret-key")});
  expect(()=>captchaCreateSchema.parse({...args,options:{callbackUrl:"https://untrusted.test"}})).toThrow();
  expect(()=>captchaCreateSchema.parse({...args,clientKey:"override"})).toThrow();
});

it("supports pending AntiGate variables without exposing arbitrary provider methods", async () => {
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(Response.json({errorId:0}));
  const provider=createCaptchaProviders({keys:{"anti-captcha":"key"},rates:[],fetch:fetcher})[2]!;
  await provider.pushVariable("123","code","value");
  expect(fetcher.mock.calls[0]![0]).toBe("https://api.anti-captcha.com/pushAntiGateVariable");
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({clientKey:"key",taskId:123,name:"code",value:"value"});
});

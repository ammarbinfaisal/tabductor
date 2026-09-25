import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { AppError } from "@tabductor/core";
import { captchaCreateSchema, type CaptchaJob, type CaptchaService } from "@tabductor/engine";
import { defineTool, type AgentTool } from "./tools.js";

export function captchaTools(service: CaptchaService | undefined, beforeCall?: () => Promise<unknown>): AgentTool[] {
  if (!service) return [];
  const waitSchema = z.object({ job_id: z.string().min(1).max(200), wait_ms: z.number().int().min(0).max(120000).default(90000) }).strict();
  const wait = async (job: CaptchaJob, ms: number, signal?: AbortSignal) => {
    const deadline = Date.now() + ms;
    while (["pending", "submitting"].includes(job.status) && Date.now() < deadline) {
      signal?.throwIfAborted();
      const pause = Math.min(Math.max(1000, job.retry_after_ms ?? 5000), deadline - Date.now());
      if (pause > 0) await delay(pause, undefined, { signal });
      if (Date.now() >= deadline) break;
      if (await beforeCall?.()) throw new AppError("browser_fresh_perception_required", "Browser control changed; inspect the page and resume this CAPTCHA job in a new cell");
      job = await service.getResult(job.id, signal);
    }
    return job;
  };
  return [
    defineTool({ name: "captcha.providers", description: "List configured CAPTCHA providers, availability, USD prices and native task documentation. No credentials are returned. Missing rates or keys are reported explicitly.",
      parameters: z.object({}).strict(), execute: async () => ({ ok: true, value: await service.providers() }) }),
    defineTool({ name: "captcha.create_task", description: "Submit a native provider CAPTCHA task. Reserve USD balance before submission. Use an idempotency_key for this observed challenge and reuse it on retries. All provider-supported task types and fields are accepted; inspect provider documentation for exact parameters. Returns a durable run-scoped job, possibly already ready. Keys stay on the host.",
      parameters: captchaCreateSchema, execute: async (args, signal) => ({ ok: true, value: await service.createTask(args, signal) }) }),
    defineTool({ name: "captcha.get_result", description: "Read or poll an existing CAPTCHA job without submitting another solve. Returns status, full native solution when ready, or a precise error_code. An uncertain submission must not be purchased again. Solutions still need to be applied to the website and checked using Playwright.",
      parameters: waitSchema.pick({ job_id: true }), execute: async ({ job_id }, signal) => ({ ok: true, value: await service.getResult(job_id, signal) }) }),
    defineTool({ name: "captcha.wait", description: "Poll a durable CAPTCHA job on the host for up to wait_ms. Returns pending at the deadline rather than buying a new solve. Reuse job_id after another Python cell or run resume.",
      parameters: waitSchema, execute: async ({ job_id, wait_ms }, signal) => ({ ok: true, value: await wait(await service.getResult(job_id, signal), wait_ms, signal) }) }),
    defineTool({ name: "captcha.solve", description: "Create or reuse a native CAPTCHA task and poll on the host for up to wait_ms. Returns a durable job and the full provider solution. Check status: ready means apply the solution with Playwright, pending means reuse id with captcha.wait, failed means inspect error_code, uncertain means reconcile without resubmitting. No human interaction is needed for a successful provider solve.",
      parameters: captchaCreateSchema.extend({ wait_ms: waitSchema.shape.wait_ms }), execute: async ({ wait_ms, ...args }, signal) => ({ ok: true, value: await wait(await service.createTask(args, signal), wait_ms, signal) }) }),
    defineTool({ name: "captcha.push_variable", description: "Supply a named variable to this run's pending Anti-Captcha AntiGateTask. Uses the provider's pushAntiGateVariable API.",
      parameters: z.object({ job_id: z.string().min(1).max(200), name: z.string().min(1).max(200), value: z.unknown() }).strict(),
      execute: async ({ job_id, name, value }, signal) => { await service.pushVariable(job_id, name, value, signal); return { ok: true, value: { accepted: true } }; } }),
  ];
}

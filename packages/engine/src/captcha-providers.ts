import { AppError } from "@tabductor/core";
import { z } from "zod";

export const captchaProviderName = z.enum(["capsolver", "2captcha", "anti-captcha"]);
export type CaptchaProviderName = z.infer<typeof captchaProviderName>;
export type CaptchaRate = { name: CaptchaProviderName; rateVersion: string; creditUnits: number };
export const captchaTaskSchema = z.object({ type: z.string().min(1).max(160) }).catchall(z.unknown());
export const captchaCreateSchema = z.object({
  provider: captchaProviderName,
  task: captchaTaskSchema,
  idempotency_key: z.string().min(1).max(200),
  options: z.object({ languagePool: z.enum(["en", "ru"]).optional() }).strict().optional(),
}).strict();
export type CaptchaCreate = z.infer<typeof captchaCreateSchema>;
export type CaptchaProviderResult = {
  status: "pending" | "ready" | "failed";
  taskId?: string;
  solution?: Record<string, unknown>;
  errorCode?: string;
};
export type CaptchaProvider = {
  name: CaptchaProviderName;
  configured: boolean;
  rate?: CaptchaRate;
  documentation: string;
  submit: (input: CaptchaCreate, signal?: AbortSignal) => Promise<CaptchaProviderResult>;
  poll: (taskId: string, signal?: AbortSignal) => Promise<CaptchaProviderResult>;
  pushVariable: (taskId: string, name: string, value: unknown, signal?: AbortSignal) => Promise<void>;
};
const endpoints = { capsolver: "https://api.capsolver.com", "2captcha": "https://api.2captcha.com", "anti-captcha": "https://api.anti-captcha.com" };
const documentation = { capsolver: "https://docs.capsolver.com/en/guide/api-createtask/", "2captcha": "https://2captcha.com/api-docs", "anti-captcha": "https://anti-captcha.com/apidoc" };
const failure = (code: string, message: string) => new AppError(code, message, { details: { outcomeUncertain: false } });

/** Native task/solution objects preserve provider coverage without a CAPTCHA-type allowlist.
 * Only provider-owned endpoints receive credentials. No raw HTTP errors reach the agent. */
export function createCaptchaProviders(input: {
  keys: Partial<Record<CaptchaProviderName, string>>; rates: readonly CaptchaRate[]; fetch?: typeof fetch;
}): CaptchaProvider[] {
  return captchaProviderName.options.map(name => {
    const key = input.keys[name], rate = input.rates.find(r => r.name === name);
    const request = async (method: string, fields: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> => {
      if (!key) throw failure("captcha_not_configured", `${name}: API key is not configured`);
      signal?.throwIfAborted();
      try {
        const response = await (input.fetch ?? fetch)(`${endpoints[name]}/${method}`, {
          method: "POST", headers: { "content-type": "application/json" }, redirect: "error",
          body: JSON.stringify({ ...fields, clientKey: key }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error("HTTP response unacknowledged");
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Empty response");
        const chunks: Uint8Array[] = []; let bytes = 0;
        try {
          for (;;) {
            const chunk = await reader.read(); if (chunk.done) break;
            bytes += chunk.value.length;
            if (bytes > 2_000_000) throw new Error("Response too large");
            chunks.push(chunk.value);
          }
        } finally { await reader.cancel().catch(() => undefined); }
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8").replaceAll(key, "[redacted]"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid response");
        return value as Record<string, unknown>;
      } catch {
        throw new AppError("captcha_transport_uncertain", "Provider request was not acknowledged. Reuse this job; do not submit another solve.");
      }
    };
    const taskIdFor = (id: string) => {
      if (name === "capsolver") return id;
      const value = Number(id);
      if (!/^\d+$/.test(id) || !Number.isSafeInteger(value) || value <= 0) throw failure("captcha_task_id_invalid", "Invalid provider task identifier");
      return value;
    };
    const parse = (value: Record<string, unknown>, existingId?: string): CaptchaProviderResult => {
      const id = value.taskId ?? existingId;
      const taskId = typeof id === "string" && id.length > 0 && id.length <= 200 || typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? String(id) : undefined;
      if (typeof value.errorId === "number" && value.errorId > 0) return { status: "failed", taskId,
        errorCode: typeof value.errorCode === "string" && /^[A-Z0-9_]{1,100}$/.test(value.errorCode) ? value.errorCode : "PROVIDER_REJECTED" };
      if (value.errorId !== 0) throw new AppError("captcha_transport_uncertain", "Invalid provider response; reuse this job.");
      if (value.status === "ready" && value.solution && typeof value.solution === "object" && !Array.isArray(value.solution))
        return { status: "ready", taskId, solution: value.solution as Record<string, unknown> };
      if (taskId && (value.status === undefined || value.status === null || value.status === "processing" || value.status === "idle")) return { status: "pending", taskId };
      throw new AppError("captcha_transport_uncertain", "Provider returned no usable task or solution; reuse this job.");
    };
    return { name, configured: Boolean(key), rate, documentation: documentation[name],
      submit: async (args, signal) => parse(await request("createTask", { task: args.task, ...args.options }, signal)),
      poll: async (taskId, signal) => parse(await request("getTaskResult", { taskId: taskIdFor(taskId) }, signal), taskId),
      async pushVariable(taskId, variable, value, signal) {
        if (name !== "anti-captcha") throw failure("captcha_operation_unsupported", "push_variable is an Anti-Captcha AntiGate operation");
        const response = await request("pushAntiGateVariable", { taskId: taskIdFor(taskId), name: variable, value }, signal);
        if (response.errorId !== 0) throw failure("captcha_variable_rejected", "Provider did not accept the AntiGate variable");
      },
    };
  });
}

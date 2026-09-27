import { z } from "zod";
import type { CaptchaService } from "@tabductor/engine";
import { captchaTools } from "./captcha-tools.js";
import { defineTool, type AgentTool } from "./tools.js";

const actions = ["providers", "create_task", "get_result", "wait", "solve", "push_variable"] as const;
const parameters = z.object({
  action: z.enum(actions),
  provider: z.string().optional(),
  task: z.record(z.unknown()).optional(),
  idempotency_key: z.string().optional(),
  options: z.record(z.unknown()).optional(),
  job_id: z.string().optional(),
  wait_ms: z.number().int().min(0).max(120000).optional(),
  name: z.string().optional(),
  value: z.unknown().optional(),
}).strict();

/** One model tool, with operation-specific validation delegated to the service tools. */
export function browserCaptchaTool(service: CaptchaService, beforeCall?: () => Promise<unknown>): AgentTool {
  const operations = new Map(captchaTools(service, beforeCall).map(tool => [tool.name.slice("captcha.".length), tool]));
  return defineTool({
    name: "browser.captcha",
    description: "Solve observed CAPTCHAs with configured providers. action=providers lists availability and native task docs; create_task/solve require provider, native task and stable idempotency_key; get_result/wait require job_id; push_variable requires job_id, name and value. solve and wait accept wait_ms up to 120000. Apply a ready solution on the page with browser.python and verify it.",
    parameters,
    execute: async ({ action, ...args }, signal) => {
      const operation = operations.get(action)!;
      const fields = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
      return operation.execute(fields, signal);
    },
  });
}

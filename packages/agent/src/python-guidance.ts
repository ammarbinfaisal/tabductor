import { PROMPT_INPUT_GUIDANCE } from "@tabductor/core";
import { asSchema } from "ai";
import type { AgentTool } from "./tools.js";

export const PYTHON_CAPTCHA_GUIDANCE = `When CAPTCHA solving is available, use the injected captcha object inside browser.python:
captcha.providers() lists provider availability, rates and native task documentation.
captcha.create_task(provider=..., task={...}, idempotency_key=..., options={...}) submits or reuses a native provider task; options is optional.
captcha.solve(provider=..., task={...}, idempotency_key=..., wait_ms=90000, options={...}) submits or reuses a task and waits on the host.
captcha.get_result(job_id=...) reads or polls an existing job. captcha.wait(job_id=..., wait_ms=90000) polls it on the host; wait_ms is optional and capped at 120000.
captcha.push_variable(job_id=..., name=..., value=...) supplies a variable to a pending Anti-Captcha AntiGateTask.
Use browser.describe(name='captcha.solve') for exact schemas. Gather task fields from the observed challenge and provider documentation. Reuse the same idempotency_key for retries of that challenge.
Results are dictionaries: inspect job['status']; ready provides job['solution'], pending/submitting should resume with captcha.wait(job_id=job['id']), failed provides error_code, and uncertain requires reconciliation without purchasing a replacement. Apply a ready solution with Playwright and verify website acceptance. Provider credentials stay on the host.`;

/** Keep the model's permanent tool surface small; exact schemas stay available on demand. */
export function sdkCatalog(tools: Iterable<AgentTool>): string {
  return [...tools].map(tool => {
    const schema = asSchema(tool.parameters).jsonSchema as { properties?: Record<string, { type?: string; enum?: unknown[] }>; required?: string[] };
    const args = Object.entries(schema.properties ?? {}).map(([name, field]) =>
      `${name}${schema.required?.includes(name) ? "" : "?"}:${field.enum ? field.enum.map(v => JSON.stringify(v)).join("|") : field.type ?? "value"}`);
    return `api.${tool.name === "done" || tool.name === "fail" ? "run." : ""}${tool.name}(${args.join(", ")})`;
  }).join("\n");
}

export const PYTHON_BROWSER_GUIDANCE = `browser.python is a persistent Python REPL for this browser task run. Variables, imports, functions, classes and browser objects persist across calls. Reuse names defined in earlier calls; use print(...) to show a result.
Use Playwright directly for browser automation. Write normal synchronous Python with playwright.sync_api.
Call methods directly: print(page.title()) and page.locator('body').inner_text(). Do not use await or async def for browser operations.
For application globals use page.evaluate("mw:() => window.appData"); ordinary DOM evaluation, handles and exposed callbacks use native Playwright evaluation. Main-world evaluation returns JSON and cannot return handles.
Tools: browser.python executes code; browser.screenshot returns an image directly; browser.network inspects earlier requests; browser.captcha handles solver jobs.
Injected objects: page, context, expect, browser, and captcha. Browser imports use playwright.sync_api, for example from playwright.sync_api import Page, Locator, expect, TimeoutError.
Use the existing page and context; no sync_playwright() or browser launch is needed or available. browser provides run services and bounded browser tools.
Use page.get_by_role, page.locator, locator.fill/click, page.keyboard/mouse, page.evaluate(expression, arg=...),
page.evaluate_handle, locator.evaluate_all, page.frames, page.screenshot and context.pages/new_page.
Callbacks and with page.expect_popup/expect_response/expect_download are supported.
Use the injected page as the stable root. Popups can close after sign-in; rediscover surviving context.pages instead of assuming context.pages[1] exists.
Ordinary exceptions retain earlier assignments; syntax errors execute nothing. Locators and callbacks persist, but page navigation or closure can invalidate handles.
A new task run or interpreter restart starts a fresh namespace. replReset in a result indicates a restart; recreate variables and reacquire browser objects. Workspace files persist across restarts.
Use normal Python open/pathlib/json for data in /workspace. Save reusable functions in agent_helpers.py;
its revisions persist automatically. Helper initialization cannot perform browser operations.
${PROMPT_INPUT_GUIDANCE}
browser.input contains the current trigger. browser.emit(type=...,packet=...,dedupeKey=...) and browser.emit.batch publish events.
Use browser.memory.get/set for observed facts and pending work.
Use browser.ai(prompt, schema_def) for a bounded semantic subtask that must return JSON matching the supplied JSON Schema. Keep the prompt tied to current task input, preserve the exact schema, and retain the call and use its fresh response during static execution; it does not perform browser actions.
Use standard Playwright methods, locators, assertions, events, and argument names. browser.describe(name='Page.evaluate') can inspect signatures if needed; browser.describe() lists available services.
When available, call the separate browser.network tool with action=list/read to inspect requests already observed in this run. The separate browser.captcha tool also accepts action=providers/create_task/get_result/wait/solve/push_variable for CAPTCHA jobs.
${PYTHON_CAPTCHA_GUIDANCE}

Use browser.describe(name=...) for exact schemas of available service functions before calling unfamiliar ones.
Workspace files persist automatically at cell exit.
browser.done(result=...) or browser.fail(reason=...) finishes the task. Ordinary cell return does not.
browser.deopt(reason=...,evidence=...) hands off to AI. browser.yield_control() ends a cell and returns control to the agent.

The supplied browser is already running. Its lifecycle and shared-context ownership are managed by the host; operations remain bounded to this run.
`;

export function pythonWorkflowGuidance(names: string[]): string {
  const available = new Set(names);
  const notes: Record<string, string> = {
    "browser.record.outcome": "Track each record using collection and recordKey, observed status, and a reason.",
    "browser.store.define_table": "Create tables or add nullable columns using typed definitions; existing data is retained.",
    "browser.store.query": "Read the current workflow store using one SELECT. Writes are visible immediately.",
    "browser.store.insert": "Commit a row immediately with a stable logical idempotencyKey. Reuse that key after an uncertain response.",
    "browser.store.upsert": "Commit a row by primary key, with the same idempotency rules as insert.",
    "browser.history.read": "Retrieve archived operation evidence without repeating operations.",
    "browser.output.read": "Retrieve archived output by invocation ID.",
    "browser.secrets.fill": "Fill a named secret into a locator without returning its value.",
  };
  return "Available browser and CAPTCHA service functions for this task (other functions are unavailable):\n" +
    [...available].map(name => `${name}${notes[name] ? ` — ${notes[name]}` : ""}`).join("\n");
}

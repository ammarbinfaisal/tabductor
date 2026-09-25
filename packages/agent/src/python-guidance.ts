import { asSchema } from "ai";
import type { AgentTool } from "./tools.js";

/** Keep the model's permanent tool surface small; exact schemas stay available on demand. */
export function sdkCatalog(tools: Iterable<AgentTool>): string {
  return [...tools].map(tool => {
    const schema = asSchema(tool.parameters).jsonSchema as { properties?: Record<string, { type?: string; enum?: unknown[] }>; required?: string[] };
    const args = Object.entries(schema.properties ?? {}).map(([name, field]) =>
      `${name}${schema.required?.includes(name) ? "" : "?"}:${field.enum ? field.enum.map(v => JSON.stringify(v)).join("|") : field.type ?? "value"}`);
    return `api.${tool.name === "done" || tool.name === "fail" ? "run." : ""}${tool.name}(${args.join(", ")})`;
  }).join("\n");
}

export const PYTHON_BROWSER_GUIDANCE = `Use Playwright directly for browser automation. Write normal synchronous Python with playwright.sync_api.
Call methods directly: print(page.title()) and page.locator('body').inner_text(). Do not use await or async def for browser operations.
For application globals use page.evaluate("mw:() => window.appData"); ordinary DOM evaluation, handles and exposed callbacks use native Playwright evaluation. Main-world evaluation returns JSON and cannot return handles.
Tools: browser.python executes code; browser.screenshot returns an image directly without Python.
Injected objects: page, context, expect, workflow. Browser imports use playwright.sync_api, for example from playwright.sync_api import Page, Locator, expect, TimeoutError.
Use the existing page and context; no sync_playwright() or browser launch is needed or available. workflow is an injected Tabductor service.
Use page.get_by_role, page.locator, locator.fill/click, page.keyboard/mouse, page.evaluate(expression, arg=...),
page.evaluate_handle, locator.evaluate_all, page.frames, page.screenshot and context.pages/new_page.
Callbacks and with page.expect_popup/expect_response/expect_download are supported.
Use the injected page as the stable root. Popups can close after sign-in; rediscover surviving context.pages instead of assuming context.pages[1] exists.
Objects, callbacks and Python globals expire each cell. Reacquire objects next cell; browser state and files persist.
Use normal Python open/pathlib/json for data in /workspace. Save reusable functions in agent_helpers.py;
its revisions persist automatically. Helper initialization cannot perform browser/workflow operations.
workflow.input contains the current trigger. workflow.emit(type=...,packet=...,dedupeKey=...) and workflow.emit.batch publish events.
Use workflow.memory.get/set for observed facts and pending work.
Use standard Playwright methods, locators, assertions, events, and argument names. workflow.describe(name='Page.evaluate') can inspect signatures if needed; workflow.describe() lists the separate workflow services.
Imageless captchas might be solved directly using DOM apis.

Use workflow.describe(name=...) for exact schemas of the available workflow functions before calling unfamiliar ones.
Workspace files persist automatically at cell exit.
workflow.done(result=...) or workflow.fail(reason=...) finishes the task. Ordinary cell return does not.
workflow.deopt(reason=...,evidence=...) hands off to AI. workflow.yield_control() ends a cell and returns control to the agent.

The supplied browser is already running. Its lifecycle and shared-context ownership are managed by the host; operations remain bounded to this run.
`;

export function pythonWorkflowGuidance(names: string[]): string {
  const available = new Set(names);
  const notes: Record<string, string> = {
    "workflow.record.outcome": "Report this record's observed saved, skipped, rejected or failed outcome with a reason.",
    "workflow.history.read": "Retrieve archived operation evidence without repeating operations.",
    "workflow.output.read": "Retrieve archived output by invocation ID.",
    "workflow.secrets.fill": "Fill a named secret into a locator without returning its value.",
    "workflow.captcha.providers": "Check solver availability, credit rates and provider-native task documentation before treating a CAPTCHA as a human blocker.",
    "workflow.captcha.solve": "Pass provider, its native task object and a stable idempotency_key. Check status and apply the full solution using Playwright. Pending jobs continue with captcha.wait; do not purchase duplicate solves.",
    "workflow.captcha.wait": "Resume an existing job across Python cells without submitting again.",
  };
  return "Available workflow functions for this task (other functions are unavailable):\n" +
    [...available].map(name => `${name}${notes[name] ? ` — ${notes[name]}` : ""}`).join("\n");
}

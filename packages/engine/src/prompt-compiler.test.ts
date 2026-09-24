import { describe, expect, it } from "vitest";
import { ASYNC_EVENT_EXECUTION_CONTRACT } from "./async-execution-contract.js";
import { GRAPH_AUTHORING_SYSTEM_PROMPT } from "./graph-authoring-prompts.js";
import { assemblePromptBrief, PROMPT_SYSTEM_PROMPT, type PromptCompileInput } from "./prompt-compiler.js";

it("asks browser agents to use Playwright directly and advertises screenshots", () => {
  const brief = assemblePromptBrief({ ...decisionInput, task: { ...decisionInput.task, kind: "browser" } });
  expect(brief).toContain("Use Playwright directly");
  expect(brief).toContain("playwright.sync_api");
  expect(brief).toContain("browser.screenshot");
  expect(brief).not.toContain("No other browser tools");
  expect(GRAPH_AUTHORING_SYSTEM_PROMPT).toContain("Use Playwright directly");
  expect(GRAPH_AUTHORING_SYSTEM_PROMPT).not.toContain("page.extract accepts");
});

const decisionInput: PromptCompileInput = {
  workflow: { name: "Stream records to a destination" },
  task: { name: "Store record", kind: "decision", prompt: "Upsert the record.", schedule: null },
  consumes: [{
    type: "record.discovered",
    description: "One complete source record.",
    schema: { type: "object" },
    emitters: ["Read source"],
  }],
  emits: [],
  neighbours: [{ name: "Read source", kind: "browser", prompt: "Read N records." }],
  store: [{ name: "records", columns: ["source_id", "body"], primaryKey: ["source_id"] }],
};

it("keeps requested Google sign-in automated in generated and published browser guidance", () => {
  const brief = assemblePromptBrief({ ...decisionInput,
    workflow: { name: "Archive", originalRequest: "Ensure Login with Google into notion." },
    task: { ...decisionInput.task, kind: "browser", prompt: "Prepare the destination." } });
  expect(brief).toContain("Ensure Login with Google into notion.");
  expect(brief).not.toContain("Authentication:");
  expect(GRAPH_AUTHORING_SYSTEM_PROMPT).not.toContain("Authentication:");
});

describe("asynchronous graph prompt contract", () => {
  it("is present in deterministic briefs even when no prompt model is configured", () => {
    const brief = assemblePromptBrief(decisionInput);
    expect(brief).toContain(ASYNC_EVENT_EXECUTION_CONTRACT);
    expect(brief).toContain("Emitting a packet records an asynchronous handoff");
    expect(brief).toContain("Every consumer processes its triggering item independently");
  });

  it("requires prompt compilation to preserve streaming handoff", () => {
    expect(PROMPT_SYSTEM_PROMPT).toContain("Continue scrolling or processing");
    expect(PROMPT_SYSTEM_PROMPT).toContain("emitting acknowledges durable acceptance");
    expect(PROMPT_SYSTEM_PROMPT).toContain("Do not wait for a whole scan before emitting");
  });

});

it("authors general browser tasks without prescribing role topology or destination protocols", () => {
  const brief = assemblePromptBrief({...decisionInput, task:{...decisionInput.task,kind:"browser"},
    emits:[{type:"complete",description:"Observed result",schema:{type:"object"},consumers:[]}]});
  for (const prompt of [GRAPH_AUTHORING_SYSTEM_PROMPT, brief, PROMPT_SYSTEM_PROMPT]) {
    expect(prompt).not.toMatch(/prepare-destination|write-record|destination\.contract|setupTask|readyEvent|source tasks|writer|setup readiness/);
    expect(prompt).not.toContain("Put work on different sites or systems in separate tasks");
  }
  expect(GRAPH_AUTHORING_SYSTEM_PROMPT).toContain("Use one browser task when that is sufficient");
  expect(brief).toContain("## Declared output events");
  expect(brief).toContain("complete — Observed result");
});

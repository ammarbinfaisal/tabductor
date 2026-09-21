import { describe, expect, it } from "vitest";
import { ASYNC_EVENT_EXECUTION_CONTRACT } from "./async-execution-contract.js";
import { AUTHENTICATION_EXECUTION_CONTRACT } from "./authentication-contract.js";
import { GRAPH_AUTHORING_SYSTEM_PROMPT } from "./graph-authoring-prompts.js";
import { assemblePromptBrief, PROMPT_SYSTEM_PROMPT, type PromptCompileInput } from "./prompt-compiler.js";

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
  expect(brief).toContain(AUTHENTICATION_EXECUTION_CONTRACT);
  expect(GRAPH_AUTHORING_SYSTEM_PROMPT).toContain(AUTHENTICATION_EXECUTION_CONTRACT);
  expect(GRAPH_AUTHORING_SYSTEM_PROMPT).not.toContain("If sign-in or MFA is needed, call human_action.request");
  expect(assemblePromptBrief(decisionInput)).not.toContain(AUTHENTICATION_EXECUTION_CONTRACT);
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

  it("authors any source-to-sink flow as generic asynchronously communicating stages", () => {
    expect(GRAPH_AUTHORING_SYSTEM_PROMPT).toContain(ASYNC_EVENT_EXECUTION_CONTRACT);
    expect(GRAPH_AUTHORING_SYSTEM_PROMPT).toContain("different sites or systems in separate tasks connected by events");
    expect(GRAPH_AUTHORING_SYSTEM_PROMPT).toContain("Every consumer processes its triggering item independently");
    expect(GRAPH_AUTHORING_SYSTEM_PROMPT).not.toContain("Notion");
  });
});

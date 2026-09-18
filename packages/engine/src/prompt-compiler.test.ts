import { describe, expect, it } from "vitest";
import { GRAPH_AUTHORING_SYSTEM_PROMPT } from "./graph-authoring-prompts.js";
import { assemblePromptBrief, PROMPT_SYSTEM_PROMPT, type PromptCompileInput } from "./prompt-compiler.js";

const decisionInput: PromptCompileInput = {
  workflow: { name: "Tweets to Notion" },
  task: { name: "Store tweet", kind: "decision", prompt: "Upsert the tweet.", schedule: null },
  consumes: [{
    type: "tweet.discovered",
    description: "One complete tweet.",
    schema: { type: "object" },
    emitters: ["Read timeline"],
  }],
  emits: [],
  neighbours: [{ name: "Read timeline", kind: "browser", prompt: "Read N tweets." }],
  store: [{ name: "tweets", columns: ["tweet_id", "text"], primaryKey: ["tweet_id"] }],
};

describe("asynchronous graph prompt contract", () => {
  it("is present in deterministic briefs even when no prompt model is configured", () => {
    const brief = assemblePromptBrief(decisionInput);
    expect(brief).toContain("independently and asynchronously");
    expect(brief).toContain("never wait for, poll, or coordinate downstream completion");
    expect(brief).toContain("stable record ids and idempotent store upserts");
  });

  it("requires prompt compilation to preserve streaming handoff", () => {
    expect(PROMPT_SYSTEM_PROMPT).toContain("Continue scrolling or processing");
    expect(PROMPT_SYSTEM_PROMPT).toContain("emitting acknowledges durable acceptance");
    expect(PROMPT_SYSTEM_PROMPT).toContain("Do not wait for a whole scan before emitting");
  });

  it("authors X-to-Notion work as separate asynchronously communicating browser nodes", () => {
    expect(GRAPH_AUTHORING_SYSTEM_PROMPT).toContain("reading N X timeline tweets");
    expect(GRAPH_AUTHORING_SYSTEM_PROMPT).toContain("separate event-triggered browser consumer");
    expect(GRAPH_AUTHORING_SYSTEM_PROMPT).toContain("never delay Notion writes until all N tweets");
  });
});

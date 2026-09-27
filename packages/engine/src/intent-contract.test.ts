import { expect, it, vi } from "vitest";
import { bindIntent, intentErrors } from "./intent-contract.js";
import { graphSchema } from "./testing/graph.js";
import { llmPromptCompiler, promptInputHash, type PromptCompileInput } from "./testing/prompt-compiler.js";
import { normalizeRecord, recordProcessingSchema } from "./record-processing.js";
import { destinationKey } from "./destination-contracts.js";

it("cannot turn a dedupe instruction into a prohibition through prompt expansion", async () => {
  const complete = vi.fn(async () => ({ text: "Do not create properties." }));
  const original = "Fetch 100 tweets and save their text. Do not create duplicate properties.";
  const input: PromptCompileInput = { workflow: { name: "Archive", intent: bindIntent(original), originalRequest: original },
    task: { name: "Write", kind: "browser", prompt: "Save the tweet text. Do not create duplicate properties.", schedule: null }, consumes: [], emits: [], neighbours: [], store: [] };
  const result = await llmPromptCompiler({ complete }).compile(input);
  expect(complete).not.toHaveBeenCalled();
  expect(result).toMatchObject({ ok: true, prompt: expect.stringContaining(original) });
  if (result.ok) expect(result.prompt).not.toContain("Do not create properties.");
  expect(promptInputHash({ ...input, workflow: { ...input.workflow, originalRequest: "Fetch 200" } })).not.toBe(promptInputHash(input));
  expect(promptInputHash({ ...input, neighbours: [{ name: "Other", kind: "decision", prompt: "Unrelated prose" }] })).toBe(promptInputHash(input));
});

it("rejects invented provenance and uncovered outcomes", () => {
  const original = "Read a feed";
  const graph = graphSchema.parse({ automationPrompt: original, intent: bindIntent(original, { requirements: [{ id: "source", category: "source", description: "Read a feed", quote: original }],
    constraints: [{ id: "schema", quote: "never create properties", predicate: "preserve-existing-schema" }] }), tasks: [] });
  expect(intentErrors(graph)).toEqual(expect.arrayContaining([expect.stringContaining("intent_provenance_invalid"), expect.stringContaining("intent_requirement_uncovered")]));
});

it("normalizes without inventing source facts or turning fetch quantity into save quantity", () => {
  const config = recordProcessingSchema.parse({ version: 1, eventType: "record.ready", identityField: "stable_identity", sourceIdField: "tweet_id", sourceUrlField: "url",
    contentFields: ["body"], nullableFields: ["likes"], trimFields: ["author"], canonicalUrlFields: ["url"] });
  const packet = normalizeRecord({ tweet_id: null, url: "https://twitter.com/alice/status/123?s=20&utm_source=x", author: " Alice ", body: "Exact content", likes: "" }, config);
  expect(packet).toMatchObject({ tweet_id: null, url: "https://x.com/alice/status/123", stable_identity: "url:https://x.com/alice/status/123", author: "Alice", body: "Exact content", likes: null });
  expect(() => normalizeRecord({ body: "" }, config)).toThrow("record_content_missing");
  expect(normalizeRecord({ body: "Exact content" }, config).stable_identity).toMatch(/^content:/);
  expect(normalizeRecord({ body: "Exact content" }, config)).not.toHaveProperty("tweet_id");
  const intent = bindIntent("Fetch 100 tweets and dedupe", { quantity: { target: 100, measure: "source-records", interpretation: "explicit-user-requirement" } });
  expect(intent.quantity?.measure).toBe("source-records");
});

it("canonicalizes database views without conflating different destination databases", () => {
  const id = "abcdabcdabcdabcdabcdabcdabcdabcd";
  expect(destinationKey(`https://app.notion.com/p/workspace/${id}?v=view1`)).toBe(destinationKey(`https://www.notion.so/${id}?v=view2`));
  expect(destinationKey(`https://www.notion.so/Archive-${id}?v=view1`)).toBe(destinationKey(`https://www.notion.so/${id}?v=view2#section`));
  expect(destinationKey(`https://www.notion.so/${id}`)).not.toBe(destinationKey("https://www.notion.so/11111111111111111111111111111111"));
  expect(destinationKey("https://app.test/?db=one")).not.toBe(destinationKey("https://app.test/?db=two"));
  expect(destinationKey("https://app.test/#/db/one")).not.toBe(destinationKey("https://app.test/#/db/two"));
});

import { describe, expect, it } from "vitest";
import { promptHashOf, type SchemaGenInput } from "./schema-generator.js";

/**
 * The carry-forward hash is the compiler's cache key: insensitive to what is presentation
 * (task order in the document), sensitive to everything that is context (descriptions,
 * prompts, who touches the event).
 */

const base: SchemaGenInput = {
  eventType: "tweet.detected",
  description: "A tweet the watcher found.",
  emitters: [
    { name: "Watcher", prompt: "watch the timeline" },
    { name: "Backfiller", prompt: "walk older pages" },
  ],
  consumers: [{ name: "Scorer", prompt: "rank tweets" }],
};

describe("promptHashOf", () => {
  it("ignores task ordering", () => {
    const reordered: SchemaGenInput = {
      ...base,
      emitters: [base.emitters[1]!, base.emitters[0]!],
    };
    expect(promptHashOf(reordered)).toBe(promptHashOf(base));
  });

  it("changes when the description, a prompt, or the touching set changes", () => {
    const hash = promptHashOf(base);
    expect(promptHashOf({ ...base, description: "Something else." })).not.toBe(hash);
    expect(
      promptHashOf({
        ...base,
        emitters: [base.emitters[0]!, { name: "Backfiller", prompt: "walk ALL older pages" }],
      }),
    ).not.toBe(hash);
    expect(promptHashOf({ ...base, consumers: [] })).not.toBe(hash);
  });

  it("does not collide when a name/prompt boundary shifts", () => {
    const a = promptHashOf({ ...base, emitters: [{ name: "Watcher", prompt: "ab" }], consumers: [] });
    const b = promptHashOf({ ...base, emitters: [{ name: "Watchera", prompt: "b" }], consumers: [] });
    expect(a).not.toBe(b);
  });
});

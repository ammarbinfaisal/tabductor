import { expect, it } from "vitest";
import { estimateModelInput } from "./model-input.js";

it("distinguishes bytes from tokens and handles multilingual text and special token strings", () => {
  const input = estimateModelInput({ text: "A visible record with an author and a URL. ".repeat(4000) });
  expect(input.requestBytes).toBeGreaterThan(128000);
  expect(input.inputTokenBound).toBeLessThan(128000);
  expect(estimateModelInput({ text: "مرحبا 🌍 <|endoftext|>" }).inputTokenBound).toBeGreaterThan(1024);
  expect(() => estimateModelInput("a".repeat(4_000_001))).toThrow("4 MB");
});

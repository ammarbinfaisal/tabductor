import { expect, it } from "vitest";
import { buildEvidence, missingEvidence, renderEvidence } from "./evidence.js";

it("refuses promotion when the static runtime cannot reproduce an interaction", () => {
  for (const action of [
    { action: "select" },
    { action: "scroll", selector: "#results", direction: "down" },
    { action: "scroll", direction: "right" },
    { action: "switchTab" },
  ]) {
    const evidence = buildEvidence({ runId: "run", entries: [
      { seq: 0, kind: "action", payload: { action: "goto", url: "https://fixture.test", ok: true } },
      { seq: 1, kind: "action", payload: { ...action, ok: true } },
    ] });
    expect(missingEvidence(evidence)).toContain("retain AI mode");
  }
});

it("keeps ordinary viewport scrolling eligible for compilation", () => {
  const evidence = buildEvidence({ runId: "run", entries: [
    { seq: 0, kind: "action", payload: { action: "goto", url: "https://fixture.test", ok: true } },
    { seq: 1, kind: "action", payload: { action: "scroll", direction: "down", ok: true } },
  ] });
  expect(missingEvidence(evidence)).toBeNull();
});

it("supplies structural coverage and field selectors to the compiler without page values", () => {
  const evidence = buildEvidence({ runId: "run", entries: [
    { seq: 0, kind: "action", payload: { action: "perceive", ok: true,
      coverage: { totalElements: 100, nextElementOffset: 25 },
      elementStructure: [{ tag: "article", role: "article", locator: '[data-testid="item"]' }] } },
    { seq: 1, kind: "action", payload: { action: "queryAll", selector: "article", ok: true,
      fields: ["author"], count: 25, extractionFields: { author: { selector: ".author" } } } },
  ] });
  const rendered = renderEvidence(evidence, "fixture");
  expect(rendered).toContain("nextElementOffset");
  expect(rendered).toContain(".author");
  expect(rendered).toContain("article");
});

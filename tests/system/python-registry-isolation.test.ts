import { expect, it } from "vitest";
import { buildPythonToolRegistry } from "@tabductor/agent";

/**
 * The §4 security boundary made a test, extending `mcp-registry-isolation.test.ts`'s and
 * `decision-registry-isolation.test.ts`'s own pattern to `(asset, python)` (S5h). Unlike
 * every other `(kind, mode)` registry, the assertion here is not "these names and no
 * others" — it is that the schema is **empty**, full stop: `python-compute.md` §2.1's own
 * words, "not a filtered list". A Python job has no `emit`, no `done`/`fail`, no tool
 * surface of any kind; its inputs are resolved before the microVM boots and its outputs
 * collected after it exits, with no host bridge in between for a tool call to cross.
 */
it("the (asset, python) registry has no tools at all — not a filtered list, an empty one", () => {
  const tools = buildPythonToolRegistry();
  expect(tools).toEqual([]);
});

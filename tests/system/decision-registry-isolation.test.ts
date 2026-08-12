import { expect, it } from "vitest";
import { buildDecisionToolRegistry, type EmitFn } from "@tabductor/agent";
import pg from "pg";

/**
 * The §4 security boundary made a test, extending `mcp-registry-isolation.test.ts`'s own
 * pattern (asserted there for browser/asset) to `kind=decision` (S5g): the smallest registry
 * in the system is `store.query` + `emit` + `done`/`fail`, and **nothing else** — no
 * `page.*`, no `network.*`, no `mcp.*`, no `assets.*`, and, just as load-bearing, no
 * `store.insert`/`store.upsert` (§2.1's kind table: "store access: read only"). A future
 * refactor that accidentally merges the decision and asset registries must fail here.
 *
 * Registry construction touches no I/O (`buildDecisionToolRegistry` never calls the pool
 * until a tool's `execute` runs — the same proof `mcp-registry-isolation.test.ts` makes for
 * the other two kinds), so a `pg.Pool` that was never `.connect()`ed is a type-satisfying
 * stand-in, not a live connection this test has to tear down.
 */

const fakePool = new pg.Pool({ max: 0 });
const fakeEmit: EmitFn = async () => {
  throw new Error("not used in the registry-isolation test: emit");
};

it("the decision (kind=decision) registry has ONLY store.query, emit, done, fail", () => {
  const tools = buildDecisionToolRegistry({ pool: fakePool, workflowId: "wf_test", emit: fakeEmit });
  const names = tools.map((t) => t.name);

  expect(names.some((n) => n.startsWith("page."))).toBe(false);
  expect(names.some((n) => n.startsWith("network."))).toBe(false);
  expect(names.some((n) => n.startsWith("mcp."))).toBe(false);
  expect(names.some((n) => n.startsWith("assets."))).toBe(false);
  expect(names).not.toContain("store.insert");
  expect(names).not.toContain("store.upsert");
  expect(names.some((n) => n.startsWith("secrets."))).toBe(false);

  // The positive control, mirroring the browser/asset tests: exactly these four, nothing more.
  expect([...names].sort()).toEqual(["done", "emit", "fail", "store.query"]);
});

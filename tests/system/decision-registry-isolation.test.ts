import { expect, it } from "vitest";
import { buildDecisionToolRegistry, type EmitFn } from "@tabductor/agent";
import pg from "pg";

/**
 * The two-kind security boundary made a test: decisions own store query/insert/upsert and
 * lifecycle tools, with no browser or ambient integration capabilities.
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

it("the decision registry has only store and lifecycle tools", () => {
  const tools = buildDecisionToolRegistry({
    pool: fakePool,
    workflowId: "wf_test",
    emit: fakeEmit,
    write: {} as never,
  });
  const names = tools.map((t) => t.name);

  expect(names.some((n) => n.startsWith("page."))).toBe(false);
  expect(names.some((n) => n.startsWith("network."))).toBe(false);
  expect(names.some((n) => n.startsWith("mcp."))).toBe(false);
  expect(names.some((n) => n.startsWith("secrets."))).toBe(false);

  expect([...names].sort()).toEqual(["done", "emit", "fail", "store.insert", "store.query", "store.upsert"]);
});

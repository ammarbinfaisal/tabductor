import { expect, it } from "vitest";
import { runCompiledScript } from "@tabductor/static-rt";
import { hostWith, memoryState, script } from "./static-rt-support.js";

/**
 * The isolate's global scope, enumerated identifier by identifier.
 *
 * This is the claim the whole compiled path rests on: a script cannot reach anything except
 * `ctx`, not because a rule forbids it but because there is nothing else there. It is asserted
 * at the sandbox layer rather than only at the lint gate deliberately — the gate is a
 * convenience for producing good error messages, the isolate is the boundary, and a script
 * that somehow bypassed the gate must still find an empty room.
 */

const ABSENT = [
  "fetch",
  "require",
  "process",
  "Buffer",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "XMLHttpRequest",
  "WebSocket",
  "__dirname",
  "__filename",
  "module",
  "exports",
  "global",
  "globalThis.process",
];

it.each(ABSENT)("%s is undefined inside the isolate", async (identifier) => {
  const state = memoryState();
  const result = await runCompiledScript(
    script(`  await ctx.state.set("seen", typeof ${identifier});`),
    hostWith({ state }),
  );
  expect(result).toEqual({ outcome: "completed" });
  expect(state.all().seen).toBe("undefined");
});

it("ctx is the one thing that is defined", async () => {
  const state = memoryState();
  const result = await runCompiledScript(
    script(`  await ctx.state.set("kinds", [typeof ctx, typeof ctx.page.goto, typeof ctx.emit]);`),
    hostWith({ state }),
  );
  expect(result).toEqual({ outcome: "completed" });
  expect(state.all().kinds).toEqual(["object", "function", "function"]);
});

/**
 * The §4 boundary, as an enumeration rather than an assertion about one name — mirrors
 * `mcp-registry-isolation.test.ts` and `decision-registry-isolation.test.ts`. A compiled
 * browser script gets the browser node's capabilities and nothing else; if a future change
 * adds `ctx.mcp` this test says so before any script can use it.
 */
it("the ctx surface contains no mcp, assets, evaluate or download binding, at any depth", async () => {
  const state = memoryState();
  const result = await runCompiledScript(
    script(`
  const walk = (obj, prefix, out) => {
    for (const key of Object.keys(obj)) {
      const path = prefix ? prefix + "." + key : key;
      out.push(path);
      const value = obj[key];
      if (value && typeof value === "object") walk(value, path, out);
    }
    return out;
  };
  await ctx.state.set("surface", walk(ctx, "", []));`),
    hostWith({ state }),
  );
  expect(result).toEqual({ outcome: "completed" });

  const surface = state.all().surface as string[];
  // Positive control first: if the walk found nothing, the negative assertions below are
  // vacuous and would pass against an empty array.
  expect(surface).toContain("page.goto");
  expect(surface).toContain("guard.all");
  expect(surface).toContain("emit");
  expect(surface).toContain("deopt");

  for (const forbidden of ["mcp", "assets", "evaluate", "download", "store", "secrets"]) {
    expect(surface.filter((name) => name.toLowerCase().includes(forbidden))).toEqual([]);
  }
});

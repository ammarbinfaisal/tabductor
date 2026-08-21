import { expect, it } from "vitest";
import { runCompiledScript } from "@tabductor/static-rt";
import { hostWith, memoryState, recordingEmit, script } from "./static-rt-support.js";

/**
 * The hostile corpus, and the deopt semantics the whole self-healing loop turns on.
 *
 * Two of these cases assert an **absence** rather than a denial, which is the point of testing
 * at this layer: there is no `fetch` to refuse and no `process` to withhold, so the assertion
 * is that reaching for them yields `undefined` however you reach. Extend this table on every
 * new idea — that is a standing instruction, not a one-time exercise.
 */

it("an infinite loop is killed by the wall clock", async () => {
  const result = await runCompiledScript(script("  while (true) {}"), hostWith(), { wallClockMs: 500 });
  expect(result).toEqual({ outcome: "killed", reason: "wall_clock" });
}, 30_000);

it("a script that awaits forever is killed by the wall clock too", async () => {
  // The isolate's own timeout bounds CPU time, not time spent awaiting the host — so without
  // the host-side timer this case would hang rather than be killed.
  const result = await runCompiledScript(
    script("  await new Promise(() => {});"),
    hostWith(),
    { wallClockMs: 500 },
  );
  expect(result).toEqual({ outcome: "killed", reason: "wall_clock" });
}, 30_000);

it("a memory bomb is killed by the memory cap, distinctly from a timeout", async () => {
  const result = await runCompiledScript(
    script("  const a = [];\n  while (true) { a.push(new Array(100000).fill(7)); }"),
    hostWith(),
    { wallClockMs: 20_000, memoryMb: 16 },
  );
  expect(result).toEqual({ outcome: "killed", reason: "memory" });
}, 40_000);

it.each([
  ["constructor escape", `this.constructor.constructor("return process")()`],
  ["Function escape", `(function(){}).constructor("return process")()`],
  ["globalThis lookup", `globalThis["pro" + "cess"]`],
])("%s yields nothing reachable", async (_label, expression) => {
  const state = memoryState();
  // Deliberately routed around the lint gate: this asserts the isolate holds for a script that
  // never passed it, which is the only way to know the boundary is the boundary.
  const result = await runCompiledScript(
    script(`  let outcome;
  try {
    const got = ${expression};
    outcome = got === undefined ? "undefined" : "reached:" + typeof got;
  } catch (e) {
    outcome = "threw";
  }
  await ctx.state.set("outcome", outcome);`),
    hostWith({ state }),
  );
  expect(result.outcome).toBe("completed");
  // Either the escape throws or it resolves to nothing. What must never happen is
  // "reached:object" — a live handle to something outside the isolate.
  expect(["undefined", "threw"]).toContain(state.all().outcome);
});

it("there is no primitive to attempt a network call with", async () => {
  const state = memoryState();
  const result = await runCompiledScript(
    script(`  await ctx.state.set("kinds", [typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof require]);`),
    hostWith({ state }),
  );
  expect(result.outcome).toBe("completed");
  expect(state.all().kinds).toEqual(["undefined", "undefined", "undefined", "undefined"]);
});

it("an import is refused at instantiation, even though the lint gate would have caught it", async () => {
  const result = await runCompiledScript(`import fs from "node:fs";\nexport default async function run(ctx) {}`, hostWith());
  expect(result.outcome).toBe("error");
  expect((result as { error: string }).error).toMatch(/imports are not allowed/);
});

// -- deopt semantics -------------------------------------------------------------------------

it("ctx.deopt then return is a deopt, not a completion", async () => {
  const result = await runCompiledScript(
    script(`  return ctx.deopt("layout not recognized", { failed: ["url"] });`),
    hostWith(),
  );
  expect(result).toEqual({
    outcome: "deopt",
    prompt: "layout not recognized",
    evidence: { failed: ["url"] },
  });
});

it("throwing without deopt is an error, not a deopt", async () => {
  const result = await runCompiledScript(script(`  throw new Error("boom");`), hostWith());
  expect(result.outcome).toBe("error");
  expect((result as { error: string }).error).toContain("boom");
});

it("deopt wins over a later throw — the handoff was already requested", async () => {
  const result = await runCompiledScript(
    script(`  ctx.deopt("hand off", { why: "guards" });\n  throw new Error("and then this");`),
    hostWith(),
  );
  expect(result.outcome).toBe("deopt");
  expect((result as { prompt: string }).prompt).toBe("hand off");
});

// -- emit / state wiring ---------------------------------------------------------------------

it("emit and emitIfNew are one host function, called two ways", async () => {
  const emit = recordingEmit();
  const result = await runCompiledScript(
    script(`  await ctx.emit("a.happened", { n: 1 });\n  await ctx.emitIfNew("b.happened", { n: 2 }, { dedupeKey: "k1" });`),
    hostWith({ emit }),
  );
  expect(result).toEqual({ outcome: "completed" });
  expect(emit.calls).toEqual([
    { type: "a.happened", packet: { n: 1 } },
    { type: "b.happened", packet: { n: 2 }, dedupeKey: "k1" },
  ]);
});

it("ctx.state round-trips through the injected store", async () => {
  const state = memoryState({ cursor: "abc" });
  const result = await runCompiledScript(
    script(`  const prior = await ctx.state.get("cursor");\n  await ctx.state.set("cursor", prior + "-next");`),
    hostWith({ state }),
  );
  expect(result).toEqual({ outcome: "completed" });
  expect(state.all().cursor).toBe("abc-next");
});

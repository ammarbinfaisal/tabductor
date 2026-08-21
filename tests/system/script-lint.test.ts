import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { lintScript } from "@tabductor/compiler";

/**
 * The gate, at unit level. S6b exercises the same gate through its own `compileTask`
 * pipeline — that is duplication of *purpose*, not of code, and both are wanted: this file
 * says what the rules are, S6b's says the pipeline applies them.
 *
 * Every case is a row. Extend the table the moment anyone thinks of a new escape.
 */

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "scripts",
  "tweets.js",
);

const wrap = (body: string): string => `export default async function run(ctx) {\n${body}\n}`;

it.each([
  ["eval", wrap(`  eval("1+1");`), "no-eval"],
  ["new Function", wrap(`  const f = new Function("return 1"); await ctx.state.set("f", 1);`), "no-new-function"],
  ["static import", `import fs from "node:fs";\n${wrap("  await ctx.page.goto('/');")}`, "no-import"],
  ["dynamic import", wrap(`  await import("node:fs");`), "no-import"],
  ["with", wrap(`  with (ctx) { }`), "no-with"],
  ["bare call", wrap(`  foo();`), "non-ctx-call"],
  ["constructor chain", wrap(`  this.constructor.constructor("return process")();`), "non-ctx-call"],
  ["top-level fetch", wrap(`  await fetch("https://example.com");`), "non-ctx-call"],
])("rejects %s", (_label, source, rule) => {
  const result = lintScript(source);
  expect(result.ok).toBe(false);
  const violations = (result as { violations: { rule: string; line: number }[] }).violations;
  expect(violations.map((v) => v.rule)).toContain(rule);
  // A violation without a line number is useless to the compiler agent that has to fix it.
  for (const v of violations) expect(v.line).toBeGreaterThan(0);
});

it("passes the §11-shaped fixture script the rest of this suite runs", () => {
  expect(lintScript(readFileSync(FIXTURE, "utf8"))).toEqual({ ok: true });
});

it("allows the ctx call shapes the template actually uses", () => {
  const source = wrap(`
  const guards = [ctx.guard.url(/x/), ctx.guard.exists("a")];
  if (!(await ctx.guard.all(guards))) return ctx.deopt("p", { f: await ctx.guard.failures() });
  const rows = await ctx.page.evalExtract("article", { text: { selector: "p" } });
  for (const r of rows) await ctx.emitIfNew("t.d", r, { dedupeKey: r.text });`);
  expect(lintScript(source)).toEqual({ ok: true });
});

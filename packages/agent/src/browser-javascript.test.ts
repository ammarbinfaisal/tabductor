import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { browserJavascript } from "./browser-javascript.js";

it("supports top-level await and return without losing the last statement value",async()=>{
  const fn=runInNewContext(`(${browserJavascript("const x = await Promise.resolve(argument.value); x + 1")})`);
  expect(await fn({value:2})).toBe(3);
  const conditional=runInNewContext(`(${browserJavascript("if (argument) return 'yes'; return 'no'")})`);
  expect(await conditional(true)).toBe("yes");
});
it("preserves statement completion with nested functions and never retries runtime syntax errors",()=>{
  const source="const f = () => { return 42 }; f()";
  expect(runInNewContext(browserJavascript(source))).toBe(42);
  const context={window:{count:0}};
  expect(()=>runInNewContext(browserJavascript("window.count++; throw new SyntaxError('Illegal return statement')"),context)).toThrow("Illegal return");
  expect(context.window.count).toBe(1);
});

it("rejects malformed extraction code before executing any browser effect",()=>{
  expect(()=>browserJavascript("document.querySelector('[data-testid='tweetText']')"))
    .toThrow(expect.objectContaining({code:"browser_invalid_javascript",details:{outcomeUncertain:false}}));
  expect(()=>browserJavascript("window.count++; const x = ;"))
    .toThrow(expect.objectContaining({code:"browser_invalid_javascript"}));
});

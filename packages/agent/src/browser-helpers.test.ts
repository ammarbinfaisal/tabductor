import { expect, it } from "vitest";
import { validateHelperSource } from "./browser-helpers.js";
it("rejects invalid or eager helper code before it can poison future invocations",()=>{
  for(const source of ["export default async api => {", "while(true){}; export default () => {}", "import fs from 'fs'; export default () => {}", "export default (()=>{while(true){}})()"])
    expect(()=>validateHelperSource(source)).toThrow();
  expect(()=>validateHelperSource("export default async function(api,args) { const f = x => x.trim(); return api.page.type({text:f(args.text)}); }")).not.toThrow();
});

import ts from "typescript";
import { Script } from "node:vm";
import { AppError } from "@tabductor/core";

/** Parse before executing: a runtime SyntaxError must never cause effect replay. */
export function browserJavascript(source: string): string {
  // Camoufox supports explicit main-world JSON evaluation. Handle evaluation and
  // exposed callbacks retain the native isolated-world Playwright semantics.
  if(source.startsWith("mw:"))return "mw:"+browserJavascript(source.slice(3));
  const file = ts.createSourceFile("browser.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let body = false;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) || ts.isAwaitExpression(node)) body = true;
    ts.forEachChild(node, visit);
  };
  visit(file);
  const last = file.statements.at(-1);
  const text = last && ts.isExpressionStatement(last)
    ? source.slice(0,last.getStart(file)) + `return (${last.expression.getText(file)});` : source;
  const expression = body ? `async (argument) => {\n${text}\n}` : source;
  // Compile only. Never evaluate browser code in the host process.
  try { new Script(`(${expression}\n)`); }
  catch {
    try { new Script(expression); }
    catch { throw new AppError("browser_invalid_javascript", "JavaScript syntax is invalid; nothing was executed. Correct the code or use structured extraction.", {details:{outcomeUncertain:false}}); }
  }
  return expression;
}

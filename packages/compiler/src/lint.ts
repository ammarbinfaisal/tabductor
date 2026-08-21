import ts from "typescript";

/**
 * The gate that keeps bad code off the shelf.
 *
 * **AST-based, not string matching**, and the difference is the whole point: a regex for
 * `"eval"` rejects the word inside a comment and misses `globalThis["ev" + "al"]`. The parser
 * is the TypeScript compiler API, which is already a devDependency of every package here, so
 * it costs no new dependency — S6b and S6c both run under a "new deps: none" rule and this
 * package is the one they extend.
 *
 * The gate is not the security boundary; the isolate is. A script that somehow reached the
 * sandbox unlinted still cannot reach `process`, because there is no `process` to reach. This
 * exists so a *malformed* script is rejected before it is stored, with a reason a compiler
 * agent can act on — which is why every rule carries a line number.
 */

export type LintViolation = { rule: string; message: string; line: number };
export type LintResult = { ok: true } | { ok: false; violations: LintViolation[] };

/** Every rejection, as one row each — extend the moment anyone thinks of a new escape. */
export const LINT_RULES = [
  "no-eval",
  "no-new-function",
  "no-import",
  "no-with",
  "non-ctx-call",
] as const;
export type LintRule = (typeof LINT_RULES)[number];

/** `ctx`, `ctx.page`, `ctx.page.goto` — but not `foo.ctx.bar`, and not `ctx["page"]`. */
function isCtxChain(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return node.text === "ctx";
  if (ts.isPropertyAccessExpression(node)) return isCtxChain(node.expression);
  return false;
}

export function lintScript(source: string): LintResult {
  const file = ts.createSourceFile("script.js", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const violations: LintViolation[] = [];

  const lineOf = (node: ts.Node): number =>
    file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

  const add = (rule: LintRule, message: string, node: ts.Node): void => {
    violations.push({ rule, message, line: lineOf(node) });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === "eval") {
        add("no-eval", "eval() is not allowed", node);
      } else if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        add("no-import", "dynamic import() is not allowed", node);
      } else if (!isCtxChain(callee)) {
        // One rule, not three: `foo()`, `this.constructor.constructor(...)` and a bare
        // `fetch(...)` are all "a call to something that is not ctx".
        add("non-ctx-call", `only ctx.* may be called; found a call to ${callee.getText(file)}`, node);
      }
    } else if (ts.isNewExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === "Function") {
        add("no-new-function", "new Function() is not allowed", node);
      }
    } else if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
      add("no-import", "import declarations are not allowed", node);
    } else if (ts.isWithStatement(node)) {
      add("no-with", "with() is not allowed", node);
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(file, visit);
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

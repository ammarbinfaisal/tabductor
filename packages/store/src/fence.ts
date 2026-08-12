import { parse, type Statement, type WithStatementBinding } from "pgsql-ast-parser";

/**
 * `store.query`'s read fence, layer (a) — graph-compilation-llm.md §3.5. This is the parse
 * gate: a real SQL parser (not a regex), applied *before* the statement ever reaches
 * Postgres, so a rejection here never opens a connection at all. It is layer one of three —
 * layers (b) role/RO-transaction/search_path and (c) row cap live in `query.ts`, and none of
 * the three is optional (§3.5: "all mandatory and layered").
 *
 * Every rejection reason here is a `store_sql_rejected_total{reason}` label (§17.2) — the
 * set is closed and small on purpose, the same "bounded label set" rule every other counter
 * in this codebase follows.
 */

export type FenceReason =
  | "parse_error"
  | "multi_statement"
  | "not_select"
  | "locking_clause";

export type FenceResult = { ok: true; statement: Statement } | { ok: false; reason: FenceReason; error: string };

type WalkResult = { ok: true } | { ok: false; reason: FenceReason; error: string };

const notSelect = (type: string): WalkResult => ({
  ok: false,
  reason: "not_select",
  error: `statement type "${type}" is not a SELECT`,
});
const lockingClause: WalkResult = {
  ok: false,
  reason: "locking_clause",
  error: "locking clauses (FOR UPDATE/SHARE/…) are rejected",
};

/**
 * Recursively walks a statement tree looking for anything that is not SELECT-shaped, and —
 * within what *is* SELECT-shaped — a locking clause. One pass covers both checks because a
 * `WITH` statement's danger lives in the same place either way: its `bind[].statement` and
 * `.in` targets, which Postgres's own grammar (and this parser's `WithStatementBinding`
 * type) allows to be an `INSERT`/`UPDATE`/`DELETE` — `WITH x AS (SELECT ...) INSERT INTO ...
 * SELECT * FROM x` is a real, syntactically-select-headed write. A check that only looked at
 * the *top-level* `statement.type` would wave that straight through.
 */
function walkBinding(stmt: WithStatementBinding): WalkResult {
  switch (stmt.type) {
    case "select":
      return stmt.for !== undefined ? lockingClause : { ok: true };
    case "union":
    case "union all": {
      const left = walkBinding(stmt.left);
      return left.ok ? walkBinding(stmt.right) : left;
    }
    case "values":
      return { ok: true };
    case "with": {
      for (const b of stmt.bind) {
        const r = walkBinding(b.statement);
        if (!r.ok) return r;
      }
      return walkBinding(stmt.in);
    }
    case "with recursive": {
      const bind = walkBinding(stmt.bind);
      return bind.ok ? walkBinding(stmt.in) : bind;
    }
    case "insert":
    case "update":
    case "delete":
      return notSelect(stmt.type);
  }
}

export function fenceQuery(sql: string): FenceResult {
  let statements: Statement[];
  try {
    statements = parse(sql);
  } catch (err) {
    return { ok: false, reason: "parse_error", error: err instanceof Error ? err.message : String(err) };
  }

  // Defense in depth, not the primary control: the extended query protocol the executor uses
  // (query.ts) is single-statement *by protocol*, so a smuggled `; DROP ...` is unrepresentable
  // there regardless. This check exists so the rejection — and its `reason` label — happens
  // at the cheap parse step instead of a protocol error deep in the pool.
  if (statements.length !== 1) {
    return { ok: false, reason: "multi_statement", error: `expected exactly one statement, found ${statements.length}` };
  }

  const [statement] = statements as [Statement];
  if (!isSelectHeaded(statement)) {
    return { ok: false, reason: "not_select", error: `statement type "${statement.type}" is not a SELECT` };
  }

  const checked = walkBinding(statement);
  if (!checked.ok) return checked;
  return { ok: true, statement };
}

/** A type predicate rather than a boolean flag + cast: the parser's `Statement` union has far
 * more members (`create table`, `insert`, `drop`, …) than `WithStatementBinding` does, and TS
 * can only narrow `Statement` down to that smaller union through an actual predicate — a
 * boolean check on `.type` alone does not carry the narrowing across the call into
 * `walkBinding`. */
function isSelectHeaded(stmt: Statement): stmt is WithStatementBinding {
  switch (stmt.type) {
    case "select":
    case "union":
    case "union all":
    case "values":
    case "with":
    case "with recursive":
      return true;
    default:
      return false;
  }
}

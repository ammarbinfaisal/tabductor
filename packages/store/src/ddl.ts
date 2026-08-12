import { parse, type CreateTableStatement, type Statement } from "pgsql-ast-parser";

/**
 * Store-schema artifact validation (S5g deliverable 1; graph-compilation-llm §5 checks 4–5).
 * Deterministic, mirroring what S8's save-time gate will call — this file has no LLM in it
 * and never will. Two things are checked: the DDL's own shape (§ below), and its bijection
 * with the author's `tables_spec_json` (the ajv-checkable table specs `store.insert`/`upsert`
 * validate rows against).
 *
 * The *structural* pass here (allowed statement/column-type shapes) is layer one; layer two
 * — "applies cleanly to a scratch schema, rolled back" — is `provision.ts`'s `validateDdlApplies`,
 * which needs a live connection and so cannot live in this pure module.
 */

export type ColumnAllowedType = "int" | "bigint" | "text" | "bool" | "timestamptz" | "date" | "numeric" | "jsonb";

const TYPE_ALIASES: Record<string, ColumnAllowedType> = {
  int: "int",
  int4: "int",
  integer: "int",
  bigint: "bigint",
  int8: "bigint",
  text: "text",
  bool: "bool",
  boolean: "bool",
  timestamptz: "timestamptz",
  date: "date",
  numeric: "numeric",
  decimal: "numeric",
  jsonb: "jsonb",
};

export type StoreTableSpec = {
  /** Column names forming the primary key, in the order the DDL declares them — the upsert
   * conflict target (§3.4). */
  primaryKey: string[];
  /** An ajv-compilable JSON Schema for one row: `type: "object"`, `properties`, `required`.
   * `store.insert`/`store.upsert` validate against exactly this (§3.4) — the same "compile
   * once, reuse the validator" machinery `packet-schema.ts` uses for packets. */
  schema: Record<string, unknown>;
};

export type StoreTablesSpec = Record<string, StoreTableSpec>;

export type DdlColumn = { type: ColumnAllowedType; nullable: boolean; hasDefault: boolean };
export type DdlTable = { columns: Map<string, DdlColumn>; primaryKey: string[] };
export type DdlIssue = { table?: string; message: string };
export type DdlCheck = { ok: true; tables: Map<string, DdlTable> } | { ok: false; issues: DdlIssue[] };

function normalizeType(raw: string): ColumnAllowedType | undefined {
  return TYPE_ALIASES[raw.toLowerCase()];
}

/** Column-level `PRIMARY KEY`/table-level `PRIMARY KEY (...)` — both spellings the grammar
 * allows, folded into one `string[]` regardless of which the author wrote. */
function primaryKeyOf(stmt: CreateTableStatement): string[] {
  const fromColumns: string[] = [];
  for (const c of stmt.columns) {
    if (c.kind === "column" && c.constraints?.some((k) => k.type === "primary key")) {
      fromColumns.push(c.name.name);
    }
  }
  const fromTable: string[] = [];
  for (const c of stmt.constraints ?? []) {
    if (c.type === "primary key") fromTable.push(...c.columns.map((col) => col.name));
  }
  return [...fromColumns, ...fromTable];
}

/**
 * Structural gate over parsed DDL: exactly `CREATE TABLE` statements, unqualified names (no
 * cross-schema references — §3.3/§8 Threat 10's "never the platform tables, not other
 * workflows' schemas" extends to authorship, not just runtime role grants), an allowlisted
 * type per column, exactly one primary key declaration per table, and no foreign-key
 * constraints (v1: the store's defining query shape is anti-joins and windows over its own
 * tables, §3.2 — a dependency-ordered multi-table FK graph is not a v1 need and is deferred
 * with `store.delete`, not half-built here).
 */
export function checkDdlShape(ddl: string): DdlCheck {
  let statements: Statement[];
  try {
    statements = parse(ddl);
  } catch (err) {
    return { ok: false, issues: [{ message: `DDL does not parse: ${err instanceof Error ? err.message : String(err)}` }] };
  }

  const issues: DdlIssue[] = [];
  const tables = new Map<string, DdlTable>();

  if (statements.length === 0) {
    issues.push({ message: "DDL declares no tables" });
  }

  for (const stmt of statements) {
    if (stmt.type !== "create table") {
      issues.push({ message: `only CREATE TABLE is allowed in a store schema; found "${stmt.type}"` });
      continue;
    }
    const table = stmt.name.name;
    if (stmt.name.schema) {
      issues.push({ table, message: `table name must not be schema-qualified (found "${stmt.name.schema}.${table}")` });
      continue;
    }
    if (tables.has(table)) {
      issues.push({ table, message: `table "${table}" is declared twice` });
      continue;
    }

    const columns = new Map<string, DdlColumn>();
    for (const col of stmt.columns) {
      if (col.kind !== "column") {
        issues.push({ table, message: `"LIKE <table>" column definitions are not allowed` });
        continue;
      }
      // `ColumnConstraint`'s own union has no "foreign key" member (only the table-level
      // constraint list can carry `TableConstraintForeignKey`) — a column-level FK is always
      // spelled `REFERENCES ...`, which parses to `type: "reference"`.
      if (col.constraints?.some((c) => c.type === "reference")) {
        issues.push({ table, message: `column "${col.name.name}": foreign-key constraints are not allowed (v1)` });
      }
      const normalized = col.dataType.kind === "array" ? undefined : normalizeType(col.dataType.name);
      if (!normalized) {
        const typeName = col.dataType.kind === "array" ? "array" : col.dataType.name;
        issues.push({
          table,
          message: `column "${col.name.name}": type "${typeName}" is not in the allowlist (int/bigint/text/bool/timestamptz/date/numeric/jsonb)`,
        });
        continue;
      }
      const notNull = col.constraints?.some((c) => c.type === "not null" || c.type === "primary key") ?? false;
      const hasDefault = col.constraints?.some((c) => c.type === "default") ?? false;
      columns.set(col.name.name, { type: normalized, nullable: !notNull, hasDefault });
    }

    const primaryKey = primaryKeyOf(stmt);
    if (primaryKey.length === 0) {
      issues.push({ table, message: `table "${table}" has no primary key` });
    }
    for (const c of stmt.constraints ?? []) {
      if (c.type === "foreign key") {
        issues.push({ table, message: `foreign-key constraints are not allowed (v1)` });
      }
    }

    tables.set(table, { columns, primaryKey });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, tables };
}

/**
 * The bijection check (§5 check 5): every DDL table has a spec entry and vice versa, every
 * DDL column has a spec property and vice versa, and the spec's declared primary key matches
 * the DDL's. Column *type* is not cross-checked against the JSON Schema's `type` — ajv's
 * `type: "string"` legitimately validates a `timestamptz` (an ISO string over the wire) or a
 * `numeric` (a decimal-string to dodge float rounding), so the mapping is many-to-one and a
 * strict type-equality check would reject correct specs.
 */
export function checkTablesSpecBijective(ddlTables: Map<string, DdlTable>, spec: StoreTablesSpec): DdlIssue[] {
  const issues: DdlIssue[] = [];
  const ddlNames = new Set(ddlTables.keys());
  const specNames = new Set(Object.keys(spec));

  for (const name of ddlNames) {
    if (!specNames.has(name)) issues.push({ table: name, message: `table "${name}" has DDL but no entry in tables_spec_json` });
  }
  for (const name of specNames) {
    if (!ddlNames.has(name)) issues.push({ table: name, message: `tables_spec_json declares "${name}" but the DDL does not` });
  }

  for (const [name, ddlTable] of ddlTables) {
    const specTable = spec[name];
    if (!specTable) continue;

    const props = specTable.schema.properties;
    const specColumns = new Set(
      props && typeof props === "object" && !Array.isArray(props) ? Object.keys(props as Record<string, unknown>) : [],
    );
    const ddlColumns = new Set(ddlTable.columns.keys());

    for (const col of ddlColumns) {
      if (!specColumns.has(col)) issues.push({ table: name, message: `column "${col}" has DDL but no schema property in the spec` });
    }
    for (const col of specColumns) {
      if (!ddlColumns.has(col)) issues.push({ table: name, message: `spec property "${col}" has no matching DDL column` });
    }

    const sameKey =
      ddlTable.primaryKey.length === specTable.primaryKey.length &&
      ddlTable.primaryKey.every((c, i) => c === specTable.primaryKey[i]);
    if (!sameKey) {
      issues.push({
        table: name,
        message: `spec primaryKey ${JSON.stringify(specTable.primaryKey)} does not match the DDL's ${JSON.stringify(ddlTable.primaryKey)}`,
      });
    }
  }

  return issues;
}

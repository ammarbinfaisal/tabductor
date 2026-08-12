import type { StoreMigrationClass } from "@tabductor/db";
import type { ColumnAllowedType, DdlColumn, DdlTable } from "./ddl.js";

/**
 * The migration classifier (§6.2): diff the previous applied DDL's table map against the
 * next spec's, and say `none | additive | destructive`. SQL is generated for both additive
 * and destructive diffs — the confirmation flag gates *applying* destructive SQL
 * (`store-schema.ts`), not deriving it, so a rejected destructive publish can still show the
 * exact statements a confirmed retry would run.
 */

export type MigrationDiff = {
  class: StoreMigrationClass;
  /** One line per change, for the publish-time diff display (deliverable 1's "diffs shown
   * at publish"). Never SQL text — SQL text is `sql`, this is for a human. */
  changes: string[];
  /** Empty only for `none`. */
  sql: string;
};

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

const SQL_TYPE: Record<ColumnAllowedType, string> = {
  int: "int",
  bigint: "bigint",
  text: "text",
  bool: "boolean",
  timestamptz: "timestamptz",
  date: "date",
  numeric: "numeric",
  jsonb: "jsonb",
};

function columnDdl(name: string, col: DdlColumn): string {
  const parts = [quoteIdent(name), SQL_TYPE[col.type]];
  if (!col.nullable) parts.push("not null");
  return parts.join(" ");
}

export function classifyMigration(previous: Map<string, DdlTable>, next: Map<string, DdlTable>): MigrationDiff {
  const changes: string[] = [];
  const statements: string[] = [];
  let destructive = false;

  for (const [table, prevTable] of previous) {
    const nextTable = next.get(table);
    if (!nextTable) {
      destructive = true;
      changes.push(`drop table "${table}"`);
      statements.push(`drop table ${quoteIdent(table)};`);
      continue;
    }
    for (const [col] of prevTable.columns) {
      if (!nextTable.columns.has(col)) {
        destructive = true;
        changes.push(`drop column "${table}"."${col}"`);
        statements.push(`alter table ${quoteIdent(table)} drop column ${quoteIdent(col)};`);
      }
    }
    for (const [col, prevCol] of prevTable.columns) {
      const nextCol = nextTable.columns.get(col);
      if (!nextCol) continue;
      if (nextCol.type !== prevCol.type) {
        destructive = true;
        changes.push(`change type of "${table}"."${col}" (${prevCol.type} → ${nextCol.type})`);
        statements.push(
          `alter table ${quoteIdent(table)} alter column ${quoteIdent(col)} type ${SQL_TYPE[nextCol.type]} using ${quoteIdent(col)}::${SQL_TYPE[nextCol.type]};`,
        );
      }
      if (prevCol.nullable && !nextCol.nullable) {
        destructive = true;
        changes.push(`"${table}"."${col}" becomes NOT NULL`);
        statements.push(`alter table ${quoteIdent(table)} alter column ${quoteIdent(col)} set not null;`);
      }
    }
    const prevPk = prevTable.primaryKey.join(",");
    const nextPk = nextTable.primaryKey.join(",");
    if (prevPk !== nextPk) {
      destructive = true;
      changes.push(`primary key of "${table}" changes (${prevPk} → ${nextPk})`);
      const addPk =
        nextTable.primaryKey.length > 0
          ? ` add primary key (${nextTable.primaryKey.map(quoteIdent).join(", ")})`
          : "";
      statements.push(
        `alter table ${quoteIdent(table)} drop constraint ${quoteIdent(`${table}_pkey`)}${addPk ? "," + addPk : ""};`,
      );
    }
  }

  for (const [table, nextTable] of next) {
    const prevTable = previous.get(table);
    if (!prevTable) {
      changes.push(`add table "${table}"`);
      const cols = [...nextTable.columns.entries()].map(([name, col]) => columnDdl(name, col));
      const pk = nextTable.primaryKey.length > 0 ? `, primary key (${nextTable.primaryKey.map(quoteIdent).join(", ")})` : "";
      statements.push(`create table ${quoteIdent(table)} (${cols.join(", ")}${pk});`);
      continue;
    }
    for (const [col, nextCol] of nextTable.columns) {
      if (prevTable.columns.has(col)) continue;
      // A new column is additive only when it can apply to existing rows without a value —
      // nullable or defaulted (§6.2: "new nullable/defaulted column"). A new NOT NULL column
      // with no default cannot be satisfied by rows that already exist, so it is destructive
      // even though nothing is being *removed* — the shape genuinely cannot apply forward, and
      // (v1) has no generated statement at all: backfilling a value is a design decision no
      // migrator should make silently, even under the confirmation flag.
      if (nextCol.nullable || nextCol.hasDefault) {
        changes.push(`add column "${table}"."${col}"`);
        statements.push(`alter table ${quoteIdent(table)} add column ${columnDdl(col, nextCol)};`);
      } else {
        destructive = true;
        changes.push(`add NOT NULL column "${table}"."${col}" with no default (cannot backfill existing rows) — apply manually`);
      }
    }
  }

  if (changes.length === 0) return { class: "none", changes: [], sql: "" };
  return { class: destructive ? "destructive" : "additive", changes, sql: statements.join("\n") };
}

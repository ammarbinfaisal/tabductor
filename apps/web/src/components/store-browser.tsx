"use client";

import { createStore } from "zustand/vanilla";
import { SectionLabel } from "./primitives.js";
import { api, asApiError, type RouterOutputs } from "../lib/api.js";
import { useStoreBridge } from "../lib/store.js";

/**
 * U3.5: the workflow store browser + read-only query console + schema-diff-at-publish panel.
 * Three procedures, all `store.*` (`apps/web/src/server/routers/store.ts`), all thin
 * composition over `@tabductor/store`'s already-fenced, already-tested read path — this
 * component renders their output and nothing more. The console textarea below runs the
 * *exact* `runStoreQuery` the decision node's `store.query` tool calls; there is no second
 * path here, fenced more loosely, "for the UI".
 *
 * One store, module-level, rebuilt per workflow the same way `share-panel.tsx`'s does — this
 * page shows exactly one workflow's store at a time.
 */

type Overview = RouterOutputs["store"]["overview"];
type QueryResult = RouterOutputs["store"]["query"];
type MigrationDiff = RouterOutputs["store"]["previewMigration"];

type State = {
  workflowId: string;
  overview: Overview | null;
  overviewError: string | null;

  sql: string;
  queryBusy: boolean;
  queryResult: QueryResult | null;
  queryError: string | null;

  description: string;
  ddlDraft: string;
  specDraft: string;
  diff: MigrationDiff | null;
  diffError: string | null;
  publishBusy: boolean;
  publishError: string | null;
  publishNotice: string | null;
};

const initial: Omit<State, "workflowId"> = {
  overview: null,
  overviewError: null,
  sql: "",
  queryBusy: false,
  queryResult: null,
  queryError: null,
  description: "",
  ddlDraft: "",
  specDraft: "",
  diff: null,
  diffError: null,
  publishBusy: false,
  publishError: null,
  publishNotice: null,
};

const store = createStore<State>(() => ({ workflowId: "", ...initial }));

async function loadOverview(): Promise<void> {
  const { workflowId } = store.getState();
  if (!workflowId) return;
  try {
    const overview = await api.store.overview.query({ workflowId });
    store.setState({ overview, overviewError: null });
  } catch (err) {
    store.setState({ overviewError: asApiError(err).message });
  }
}

async function runQuery(): Promise<void> {
  const { workflowId, sql } = store.getState();
  if (!sql.trim()) return;
  store.setState({ queryBusy: true, queryError: null });
  try {
    const queryResult = await api.store.query.query({ workflowId, sql });
    store.setState({ queryBusy: false, queryResult });
  } catch (err) {
    // The fence's own rejections never throw — this catch is for the genuinely exceptional
    // case (no workflow, no pool configured), not a rejected SELECT.
    store.setState({ queryBusy: false, queryError: asApiError(err).message, queryResult: null });
  }
}

/** JSON.parse's own return type is `any`, kept here rather than narrowed to `unknown` — the
 * latter would need a cast to reach the tRPC call below (house rule: no `as`-casting), and
 * the real check is the server's zod boundary (`storeTableSpecSchema`), not this parse. This
 * is client convenience only. */
function parseTablesSpec(text: string): { ok: true; value: any } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: `table spec isn't valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function previewDiff(): Promise<void> {
  const { workflowId, ddlDraft, specDraft } = store.getState();
  const parsed = parseTablesSpec(specDraft);
  if (!parsed.ok) {
    store.setState({ diffError: parsed.error, diff: null });
    return;
  }
  store.setState({ diffError: null });
  try {
    const diff = await api.store.previewMigration.query({ workflowId, ddl: ddlDraft, tablesSpec: parsed.value });
    store.setState({ diff, diffError: null });
  } catch (err) {
    store.setState({ diffError: asApiError(err).message, diff: null });
  }
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}

async function publish(confirmDestructive: boolean): Promise<void> {
  const { workflowId, ddlDraft, specDraft, description } = store.getState();
  const parsed = parseTablesSpec(specDraft);
  if (!parsed.ok) {
    store.setState({ publishError: parsed.error });
    return;
  }
  store.setState({ publishBusy: true, publishError: null, publishNotice: null });
  try {
    const result = await api.workflow.publishStoreSchema.mutate({
      workflowId,
      ddl: ddlDraft,
      tablesSpec: parsed.value,
      ...(description ? { description } : {}),
      ...(confirmDestructive ? { confirmDestructive: true } : {}),
    });
    store.setState({
      publishBusy: false,
      publishNotice: `published v${result.version} · ${result.migrationClass} — ${result.changes.join("; ")}`,
      diff: null,
    });
    await loadOverview();
  } catch (err) {
    const apiErr = asApiError(err);
    const changes = apiErr.details.changes;
    // `STORE_MIGRATION_DESTRUCTIVE`'s `AppError.details.changes` (`store-schema.ts`) round-trips
    // the exact diff a `confirmDestructive: true` retry would apply — re-showing it here as
    // the diff panel means the confirm button that appears is the retry, not a dead end.
    const fallbackDiff: MigrationDiff | undefined = isStringArray(changes)
      ? { class: "destructive", changes, sql: "" }
      : undefined;
    store.setState({
      publishBusy: false,
      publishError: apiErr.message,
      ...(fallbackDiff ? { diff: fallbackDiff } : {}),
    });
  }
}

export function StoreBrowser({ workflowId }: { workflowId: string }) {
  if (store.getState().workflowId !== workflowId) {
    store.setState({ workflowId, ...initial });
    void loadOverview();
  }
  const state = useStoreBridge(store);

  return (
    <>
      <h1 style={{ marginBottom: "var(--space-2)" }}>Store</h1>
      <p className="muted">
        The workflow&apos;s own state — one Postgres schema, read by decision nodes and written
        by asset nodes, never edges or trace rows (
        <code>docs/graph-compilation-llm.md</code> §3). Everything below routes through the
        same fenced read path <code>store.query</code> uses: one SELECT, the reader role, a
        read-only transaction, a row cap. There is no owner shortcut around it.
      </p>

      {state.overviewError ? <div className="banner banner--error">{state.overviewError}</div> : null}

      <section>
        <SectionLabel>
          Tables{state.overview?.schemaVersion != null ? ` · schema v${state.overview.schemaVersion}` : ""}
        </SectionLabel>
        {state.overview?.description ? <p className="muted">{state.overview.description}</p> : null}
        {!state.overview || state.overview.tables.length === 0 ? (
          <p className="muted">No store schema published for this workflow yet.</p>
        ) : (
          <table className="ledger">
            <thead>
              <tr>
                <th>Table</th>
                <th>Primary key</th>
                <th>Columns</th>
                <th>Rows</th>
              </tr>
            </thead>
            <tbody>
              {state.overview.tables.map((t) => (
                <tr key={t.name}>
                  <td className="mono">{t.name}</td>
                  <td className="mono muted">{t.primaryKey.join(", ")}</td>
                  <td className="mono muted">{t.columns.join(", ")}</td>
                  <td className="mono">
                    {t.rowCount !== null ? (
                      t.rowCount
                    ) : (
                      <span title={t.rowCountError ?? ""} style={{ color: "var(--status-failed)" }}>
                        error
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <SectionLabel>Query console · read-only</SectionLabel>
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          One SELECT statement. Writes, DDL, multi-statement text and locking clauses are
          rejected before any connection opens — the same corpus <code>store.query</code>&apos;s
          own tests assert on.
        </p>
        <textarea
          rows={4}
          style={{ width: "100%" }}
          value={state.sql}
          onChange={(e) => store.setState({ sql: e.target.value })}
          placeholder="select * from candidates limit 20"
        />
        <div className="row" style={{ justifyContent: "flex-end", marginTop: "var(--space-2)" }}>
          <button disabled={state.queryBusy || !state.sql.trim()} onClick={() => void runQuery()}>
            {state.queryBusy ? "Running…" : "Run query"}
          </button>
        </div>
        {state.queryError ? <div className="banner banner--error">{state.queryError}</div> : null}
        {state.queryResult ? <QueryResultView result={state.queryResult} /> : null}
      </section>

      <section>
        <SectionLabel>Publish a store schema</SectionLabel>
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          No compiler authors this yet (S8) — DDL and the table spec are entered directly.
          Preview the diff before publishing; a destructive change (dropped table or column,
          a narrowed type) needs an explicit second confirm.
        </p>
        <label className="field">
          <span>Description</span>
          <input
            value={state.description}
            onChange={(e) => store.setState({ description: e.target.value })}
            placeholder="candidates awaiting a visit; visited once processed"
          />
        </label>
        <label className="field" style={{ marginTop: "var(--space-3)" }}>
          <span>DDL</span>
          <textarea
            rows={6}
            style={{ width: "100%" }}
            value={state.ddlDraft}
            onChange={(e) => store.setState({ ddlDraft: e.target.value, diff: null })}
            placeholder={"CREATE TABLE visited (\n  tweet_id text PRIMARY KEY,\n  visited_at timestamptz NOT NULL\n);"}
          />
        </label>
        <label className="field" style={{ marginTop: "var(--space-3)" }}>
          <span>Table spec (JSON)</span>
          <textarea
            rows={6}
            style={{ width: "100%" }}
            value={state.specDraft}
            onChange={(e) => store.setState({ specDraft: e.target.value, diff: null })}
            placeholder='{"visited": {"primaryKey": ["tweet_id"], "schema": {"type": "object", "properties": {"tweet_id": {"type": "string"}}, "required": ["tweet_id"]}}}'
          />
        </label>
        <div className="row" style={{ justifyContent: "flex-end", marginTop: "var(--space-2)" }}>
          <button disabled={!state.ddlDraft.trim()} onClick={() => void previewDiff()}>
            Preview diff
          </button>
        </div>
        {state.diffError ? <div className="banner banner--error">{state.diffError}</div> : null}
        {state.diff ? <DiffPanel diff={state.diff} busy={state.publishBusy} /> : null}
        {state.publishError ? <div className="banner banner--error">{state.publishError}</div> : null}
        {state.publishNotice ? <div className="banner">{state.publishNotice}</div> : null}
      </section>
    </>
  );
}

function DiffPanel({ diff, busy }: { diff: MigrationDiff; busy: boolean }) {
  const destructive = diff.class === "destructive";
  return (
    <div className={`banner${destructive ? " banner--warning" : ""}`}>
      <p style={{ margin: 0, fontWeight: 600 }}>
        {diff.class === "none" ? "No change." : `${diff.class} migration`}
      </p>
      {diff.changes.length > 0 ? (
        <ul style={{ margin: "var(--space-2) 0" }}>
          {diff.changes.map((c) => (
            <li key={c} className="mono" style={{ fontSize: "var(--text-sm)" }}>
              {c}
            </li>
          ))}
        </ul>
      ) : null}
      {diff.class !== "none" ? (
        <button
          className={destructive ? "btn--destructive" : "btn--primary"}
          disabled={busy}
          onClick={() => void publish(destructive)}
        >
          {destructive ? "Publish anyway (destructive)" : "Publish"}
        </button>
      ) : null}
    </div>
  );
}

function QueryResultView({ result }: { result: QueryResult }) {
  if (!result.ok) {
    return (
      <div className="banner banner--error">
        <span className="mono">{result.reason}</span> — {result.error}
      </div>
    );
  }
  if (result.rows.length === 0) return <p className="muted">No rows.</p>;
  const columns = Object.keys(result.rows[0] ?? {});
  return (
    <>
      <div style={{ overflowX: "auto" }}>
        <table className="ledger">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, i) => (
              // No stable row identity exists (arbitrary query results, no declared key) —
              // index is safe here because this table is replaced wholesale on every run,
              // never patched in place.
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c} className="mono">
                    {formatCell(row[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result.truncated ? (
        <p className="muted" style={{ fontSize: "var(--text-sm)" }}>
          truncated at {result.rows.length} rows — refine the query to see more.
        </p>
      ) : null}
    </>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "∅";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

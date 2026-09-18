import { afterAll, beforeAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";

const EXPECTED_TABLES = [
  "account_baseline_rules",
  "account_identities",
  "account_mcp_tokens",
  "accounts",
  "approvals",
  "artifacts",
  "browser_allocation_requests",
  "browser_billing",
  "browser_challenges",
  "browser_commands",
  "browser_profile_leases",
  "browser_profiles",
  "browser_recording_segments",
  "browser_session_activity",
  "browser_sessions",
  "browser_workers",
  "cdp_endpoints",
  "challenge_attempts",
  "compile_jobs",
  "compile_reports",
  "compiled_scripts",
  "credit_ledger_entries",
  "credit_reservations",
  "endpoint_leases",
  "engine_status",
  "event_defs",
  "events",
  "model_credentials",
  "model_operations",
  "model_selections",
  "outbox",
  "payment_adjustments",
  "payment_purchases",
  "payment_webhook_events",
  "proposed_grants",
  "run_dedupe",
  "runs",
  "schedules",
  "secret_access_log",
  "secret_grants",
  "secrets",
  "store_schemas",
  "store_write_grants",
  "task_consumes",
  "task_emits",
  "task_grants",
  "task_state",
  "tasks",
  "trace_entries",
  "workflow_browser_profiles",
  "workflow_executions",
  "workflow_shares",
  "workflow_trigger_requests",
  "workflow_versions",
  "workflows",
];

let handle: MigratedTestDb;

beforeAll(async () => {
  handle = await createMigratedTestDb();
});

afterAll(async () => {
  await handle?.close();
});

it("migrations create every table the engine will need", async () => {
  const { rows } = await handle.db.execute<{ table_name: string }>(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name <> '__drizzle_migrations'
    ORDER BY table_name
  `);
  expect(rows.map((r) => r.table_name)).toEqual(EXPECTED_TABLES);
});

it("timestamps are timestamptz and DB-generated", async () => {
  const { rows } = await handle.db.execute<{ data_type: string; column_default: string | null }>(sql`
    SELECT data_type, column_default FROM information_schema.columns
    WHERE table_name = 'events' AND column_name = 'occurred_at'
  `);
  expect(rows[0]!.data_type).toBe("timestamp with time zone");
  expect(rows[0]!.column_default).toContain("now()");
});

it("run_dedupe's primary key is the (task_id, event_id) dedupe constraint", async () => {
  const { rows } = await handle.db.execute<{ column_name: string }>(sql`
    SELECT a.attname AS column_name
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'run_dedupe'::regclass AND i.indisprimary
    ORDER BY a.attname
  `);
  expect(rows.map((r) => r.column_name)).toEqual(["event_id", "task_id"]);
});

it("the outbox NOTIFY latch fires on commit, not before", async () => {
  const client = await handle.pool.connect();
  const notifications: string[] = [];
  client.on("notification", (n) => notifications.push(n.channel));
  await client.query("LISTEN tabductor_outbox");
  try {
    const eventId = "22222222-2222-4222-8222-222222222222";
    await handle.db.transaction(async (trx) => {
      await trx.execute(sql`INSERT INTO events (event_id, type) VALUES (${eventId}::uuid, 'test.latch')`);
      await trx.execute(sql`INSERT INTO outbox (event_id) VALUES (${eventId}::uuid)`);
      await new Promise((r) => setTimeout(r, 100));
      expect(notifications).toHaveLength(0); // held until commit
    });
    const deadline = Date.now() + 5_000;
    while (notifications.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(notifications).toEqual(["tabductor_outbox"]);
  } finally {
    await client.query("UNLISTEN tabductor_outbox");
    client.release();
  }
});

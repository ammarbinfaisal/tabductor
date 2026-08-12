import { publishStoreSchema, type PublishStoreSchemaResult } from "@tabductor/engine";
import type { StoreTablesSpec } from "@tabductor/store";
import type { MigratedTestDb } from "@tabductor/db/test-db";

/**
 * Shared fixture for the S5g system tests: the canonical `visited`/`candidates` pair from
 * graph-compilation-llm §7's worked example, published as a real store-schema artifact
 * (through `publishStoreSchema`, the same control-plane path a real save would use) rather
 * than hand-provisioned — so every test that needs a workflow store exercises the real
 * validate → classify → apply → record path once, instead of poking `packages/store`'s
 * internals directly.
 */

export const CANDIDATES_VISITED_DDL = `
CREATE TABLE candidates (
  tweet_id text PRIMARY KEY,
  url text NOT NULL,
  posted_at timestamptz NOT NULL
);
CREATE TABLE visited (
  tweet_id text PRIMARY KEY,
  url text NOT NULL,
  visited_at timestamptz NOT NULL
);
`;

export const CANDIDATES_VISITED_SPEC: StoreTablesSpec = {
  candidates: {
    primaryKey: ["tweet_id"],
    schema: {
      type: "object",
      properties: { tweet_id: { type: "string" }, url: { type: "string" }, posted_at: { type: "string" } },
      required: ["tweet_id", "url", "posted_at"],
      additionalProperties: false,
    },
  },
  visited: {
    primaryKey: ["tweet_id"],
    schema: {
      type: "object",
      properties: { tweet_id: { type: "string" }, url: { type: "string" }, visited_at: { type: "string" } },
      required: ["tweet_id", "url", "visited_at"],
      additionalProperties: false,
    },
  },
};

export async function publishCandidatesVisitedStore(
  handle: MigratedTestDb,
  workflowId: string,
): Promise<PublishStoreSchemaResult> {
  return publishStoreSchema(handle.db, handle.pool, {
    workflowId,
    description: "candidates awaiting a visit; visited once processed",
    ddl: CANDIDATES_VISITED_DDL,
    tablesSpec: CANDIDATES_VISITED_SPEC,
  });
}

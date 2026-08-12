import { createHash } from "node:crypto";

/**
 * Schema/role names are *derived*, never interpolated from user input (style constraint) —
 * `workflows.id` is already a safe identifier (`newId("wf")`, no user-chosen characters), but
 * deriving through a hash buys two things a direct interpolation would not: every name is a
 * fixed, short length regardless of the id's own length (Postgres identifiers cap at 63
 * bytes, `NAMEDATALEN`), and no character `newId` could ever emit (it never emits one outside
 * `[a-z0-9_-]`, but "-" is illegal in an *unquoted* identifier) needs a quoting decision at
 * any call site. Sixteen hex characters keeps collision odds astronomically below "this
 * process's own bug budget" for the number of workflows this system will ever provision.
 */
function shortHash(workflowId: string): string {
  return createHash("sha256").update(workflowId).digest("hex").slice(0, 16);
}

export type WorkflowStoreIds = {
  /** `wfdata_<hash>` — the schema holding this workflow's LLM-defined tables (§3.2). */
  schema: string;
  /** `wfd_<hash>_r` — `NOLOGIN`, `SELECT` only (§3.3). */
  readerRole: string;
  /** `wfd_<hash>_w` — `NOLOGIN`, `SELECT/INSERT/UPDATE/DELETE` (§3.3). */
  writerRole: string;
};

export function wfIdsOf(workflowId: string): WorkflowStoreIds {
  const h = shortHash(workflowId);
  return { schema: `wfdata_${h}`, readerRole: `wfd_${h}_r`, writerRole: `wfd_${h}_w` };
}

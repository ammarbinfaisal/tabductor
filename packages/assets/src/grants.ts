import { assetWriteGrants, type Db } from "@tabductor/db";
import { eq } from "drizzle-orm";
import { minimatch } from "minimatch";

/**
 * Write-grant enforcement (S5d, techical_plan §13.5 decision 14, §18.2). Reads are never
 * grant-scoped — this module has nothing to say about `assets.read`/`assets.list`.
 *
 * **This is real now, not deferred.** `impl-phases.md`'s S5d bullet and its own test
 * ("write outside grant glob → denied") require it, and S5h's extraction path already
 * assumes it exists and enforces it. The apparent tension with `techical_plan.md`'s Phase 7
 * line — asset write grants "tighten from 'any path in the user namespace' to the per-task
 * `path_glob`" — resolves the same way S5c's `checkMcpCall`/`AllowAllGate` resolves it
 * everywhere else in the plan: the glob-matching mechanism is built here, at S5d; what
 * Phase 7 changes is the *default for an ungranted task*, from allow to deny. Until then, a
 * task with zero rows in `asset_write_grants` may write anywhere under its own user
 * namespace — the `AllowAllGate` default — and a task with at least one row may write only
 * to a path matching one of its globs, which is not a default at all and needs no Phase 7
 * flag to be enforced today.
 *
 * `minimatch` (see `packages/assets/package.json`) rather than a hand-rolled matcher: this
 * gate is a security boundary (which path a task may write), and glob semantics — `**`
 * crossing path segments, character classes, brace expansion — are exactly the kind of
 * "larger risk" the S5d spec's style constraints call out as the justification for a small
 * dependency here, unlike the traversal check in `paths.ts`, which stays hand-written because
 * it is a short, closed reject list rather than a grammar.
 */
export async function checkWriteGrant(db: Db, taskId: string, path: string): Promise<boolean> {
  const grants = await db
    .select({ pathGlob: assetWriteGrants.pathGlob })
    .from(assetWriteGrants)
    .where(eq(assetWriteGrants.taskId, taskId));

  if (grants.length === 0) return true;
  return grants.some((g) => minimatch(path, g.pathGlob));
}

import { inArray, sql } from "drizzle-orm";
import { events, type Db, type EventRow } from "@tabductor/db";

/**
 * Length of the causation chain ending at `eventId`, counting the event itself as 1.
 * Recursive CTE over `events.causation_id`, hard-capped so a cycle or a pathological
 * chain costs O(cap) rather than O(n). Phase 2 uses this for the per-workflow loop budget.
 */
export async function chainDepth(db: Db, eventId: string, cap = 100): Promise<number> {
  const result = await db.execute<{ depth: number }>(sql`
    WITH RECURSIVE chain(event_id, causation_id, depth) AS (
      SELECT e.event_id, e.causation_id, 1
      FROM events e
      WHERE e.event_id = ${eventId}::uuid
      UNION ALL
      SELECT p.event_id, p.causation_id, c.depth + 1
      FROM chain c
      JOIN events p ON p.event_id = c.causation_id
      WHERE c.depth < ${cap}
    )
    SELECT max(depth)::int AS depth FROM chain
  `);
  return result.rows[0]?.depth ?? 0;
}

/**
 * The chain itself, oldest ancestor first and `eventId` last — what `chainDepth` counts,
 * materialised for the control plane's lineage breadcrumb (S2c).
 *
 * Two queries rather than one: the recursive CTE walks ids cheaply, and selecting the rows
 * by id afterwards keeps the packets out of the recursion. Same cap, same reason.
 */
export async function chainOf(db: Db, eventId: string, cap = 100): Promise<EventRow[]> {
  const walked = await db.execute<{ event_id: string; depth: number }>(sql`
    WITH RECURSIVE chain(event_id, causation_id, depth) AS (
      SELECT e.event_id, e.causation_id, 1
      FROM events e
      WHERE e.event_id = ${eventId}::uuid
      UNION ALL
      SELECT p.event_id, p.causation_id, c.depth + 1
      FROM chain c
      JOIN events p ON p.event_id = c.causation_id
      WHERE c.depth < ${cap}
    )
    SELECT event_id, depth FROM chain
  `);
  const ids = walked.rows.map((r) => r.event_id);
  if (ids.length === 0) return [];

  const rows = await db.select().from(events).where(inArray(events.eventId, ids));
  const depth = new Map(walked.rows.map((r) => [r.event_id, r.depth]));
  // Deepest = furthest ancestor, so descending depth reads root → leaf.
  return rows.sort((a, b) => (depth.get(b.eventId) ?? 0) - (depth.get(a.eventId) ?? 0));
}

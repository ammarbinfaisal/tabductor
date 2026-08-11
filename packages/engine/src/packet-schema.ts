import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
const addFormats = addFormatsModule.default ?? addFormatsModule;
import { eventDefs, taskEmits, tasks, type Db, type EventDefRow } from "@tabductor/db";
import { and, eq } from "drizzle-orm";

/**
 * Packet schemas are compiled from the author's event descriptions at publish time
 * (graph.ts), which is why this is the one place ajv is used at runtime instead of zod —
 * zod is for boundaries whose shape we write ourselves. The runtime instance stays
 * non-strict: the *publish* gate is where strictness lives, and rows backfilled from the
 * pre-entity model never passed it.
 *
 * The schema belongs to the event, scoped to the emitting task's workflow version — a
 * run pinned to v3 validates against v3's schema even while v4 routes new events, the
 * same pinning rule runs follow everywhere else. The task's own `task_emits` row is the
 * emit gate: declaring the type is what licenses producing it.
 *
 * Compiling a schema is the expensive part, so validators are cached by event_def id and
 * only recompiled when the row's schema actually changes (a publish writes new rows).
 */

const ajv = addFormats(new Ajv({ allErrors: true, strict: false }));

type Cached = { schema: string; validate: ValidateFunction };

const cache = new Map<string, Cached>();

export type PacketCheck = { ok: true } | { ok: false; error: string };

export async function validatePacket(
  db: Db,
  taskId: string,
  eventType: string,
  packet: unknown,
): Promise<PacketCheck> {
  const [row] = await db
    .select({ event: eventDefs, declared: taskEmits.taskId })
    .from(tasks)
    .leftJoin(
      eventDefs,
      and(eq(eventDefs.workflowVersionId, tasks.workflowVersionId), eq(eventDefs.eventType, eventType)),
    )
    .leftJoin(taskEmits, and(eq(taskEmits.taskId, tasks.id), eq(taskEmits.eventType, eventType)))
    .where(eq(tasks.id, taskId));

  if (!row || !row.event) {
    return { ok: false, error: `no event "${eventType}" is declared in this workflow version` };
  }
  if (row.declared === null) {
    return { ok: false, error: `task does not declare emitting "${eventType}"` };
  }

  const validate = validatorFor(row.event);
  if (!validate) return { ok: false, error: `event "${eventType}" has a malformed packet schema` };
  if (validate(packet)) return { ok: true };
  return { ok: false, error: `packet failed schema for "${eventType}": ${ajv.errorsText(validate.errors)}` };
}

/** `undefined` when the stored schema is not a JSON Schema at all — narrowed, never cast. */
function validatorFor(def: EventDefRow): ValidateFunction | undefined {
  const raw = def.packetSchemaJson;
  if (typeof raw !== "boolean" && !(typeof raw === "object" && raw !== null && !Array.isArray(raw))) {
    return undefined;
  }

  const schema = JSON.stringify(raw);
  const hit = cache.get(def.id);
  if (hit?.schema === schema) return hit.validate;

  const validate = ajv.compile(raw);
  cache.set(def.id, { schema, validate });
  return validate;
}

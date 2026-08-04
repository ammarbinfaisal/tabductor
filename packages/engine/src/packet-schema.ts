import { Ajv, type ValidateFunction } from "ajv";
import { eventDefs, type Db, type EventDefRow } from "@tabductor/db";
import { and, eq } from "drizzle-orm";

/**
 * Packet schemas are *user-authored JSON Schema* (§4), which is why this is the one place
 * ajv is used instead of zod — zod is for boundaries whose shape we write ourselves.
 *
 * Compiling a schema is the expensive part, so validators are cached by event_def id and
 * only recompiled when the row's schema actually changes (a graph edit rewrites the row).
 */

const ajv = new Ajv({ allErrors: true, strict: false });

type Cached = { schema: string; validate: ValidateFunction };

const cache = new Map<string, Cached>();

export type PacketCheck = { ok: true } | { ok: false; error: string };

/** No declared event_def = nothing to validate against; the emit is a graph authoring error. */
export async function validatePacket(
  db: Db,
  taskId: string,
  eventType: string,
  packet: unknown,
): Promise<PacketCheck> {
  const [def] = await db
    .select()
    .from(eventDefs)
    .where(and(eq(eventDefs.taskId, taskId), eq(eventDefs.eventType, eventType)));

  if (!def) return { ok: false, error: `task declares no event_def for "${eventType}"` };

  const validate = validatorFor(def);
  if (!validate) return { ok: false, error: `event_def "${eventType}" has a malformed packet schema` };
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

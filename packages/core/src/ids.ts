import { randomUUID } from "node:crypto";

/** `newId("run")` → `run_9f3b0c5e-...` (UUID v4; swap for v7 when Node ships one). */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

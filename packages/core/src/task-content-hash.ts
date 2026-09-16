import { createHash } from "node:crypto";

export type TaskHashGrant = { grantKey: string; grantValue: string; requiresApproval: boolean };
export type TaskHashStoreTable = { name: string; columns: string[]; primaryKey: string[] };

/** JSON with object keys sorted at every depth, stable across jsonb round trips. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function taskContentBasisHash(input: {
  kind: string;
  prompt: string;
  limits: Record<string, unknown>;
  consumes: Array<{ type: string; schema: Record<string, unknown> | null }>;
  emits: Array<{ type: string; schema: Record<string, unknown> | null }>;
}): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export function taskContentHash(input: {
  basisHash: string;
  grants: readonly TaskHashGrant[];
  store: readonly TaskHashStoreTable[];
}): string {
  return createHash("sha256")
    .update(canonicalJson({
      basisHash: input.basisHash,
      grants: [...input.grants].sort((a, b) =>
        `${a.grantKey}\u0000${a.grantValue}`.localeCompare(`${b.grantKey}\u0000${b.grantValue}`),
      ),
      store: [...input.store].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .digest("hex");
}

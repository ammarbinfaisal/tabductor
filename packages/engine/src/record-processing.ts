import { createHash } from "node:crypto";
import { canonicalJson } from "@tabductor/core";
import { z } from "zod";

const field = z.string().min(1).max(120);
export const recordProcessingSchema = z.object({ version: z.literal(1), eventType: field, identityField: field,
  sourceNamespace: field.optional(),
  sourceIdField: field.optional(), sourceUrlField: field.optional(), contentFields: z.array(field).min(1).max(40),
  trimFields: z.array(field).max(40).default([]), nullableFields: z.array(field).max(40).default([]),
  canonicalUrlFields: z.array(field).max(40).default([]) });
export type RecordProcessing = z.infer<typeof recordProcessingSchema>;
export function canonicalSourceUrl(input: string): string {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("record_url_invalid: expected an HTTP(S) source URL");
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  // These sites expose post identity in the path; tracking queries aren't identity.
  if (["twitter.com", "www.twitter.com", "x.com", "www.x.com"].includes(url.hostname)) { url.hostname = "x.com"; url.search = ""; }
  url.searchParams.sort();
  return url.toString();
}

/** Fixed versioned operations only. No model code, store queries or network access. */
export function normalizeRecord(raw: unknown, config: RecordProcessing): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("record_packet_invalid: expected one object");
  const packet = { ...raw as Record<string, unknown> };
  if (config.identityField === config.sourceIdField) throw new Error("record_identity_namespace: derived identity must have a distinct field");
  for (const f of config.trimFields) if (typeof packet[f] === "string") packet[f] = (packet[f] as string).trim();
  for (const f of config.nullableFields) if (packet[f] === undefined || packet[f] === "") packet[f] = null;
  for (const f of config.canonicalUrlFields) if (typeof packet[f] === "string" && packet[f]) packet[f] = canonicalSourceUrl(packet[f] as string);
  for (const f of config.contentFields) if (packet[f] === undefined || packet[f] === null || packet[f] === "") throw new Error(`record_content_missing: ${f}`);
  const sourceId = config.sourceIdField && packet[config.sourceIdField];
  const url = config.sourceUrlField && packet[config.sourceUrlField];
  const namespace = config.sourceNamespace ?? (typeof url === "string" && url ? new URL(canonicalSourceUrl(url)).hostname : config.sourceIdField);
  const hasId = typeof sourceId === "string" && sourceId.trim() || typeof sourceId === "number" && Number.isSafeInteger(sourceId);
  const identity = hasId ? `source:${namespace}:${String(sourceId).trim()}`
    : typeof url === "string" && url ? `url:${canonicalSourceUrl(url)}`
    : `content:${createHash("sha256").update(canonicalJson(Object.fromEntries(config.contentFields.map(f => [f, packet[f]])))).digest("hex")}`;
  // Always host-derived; a caller cannot override a collision or pass a fabricated key.
  packet[config.identityField] = identity;
  return packet;
}

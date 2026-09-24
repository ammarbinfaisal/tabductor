import { AppError } from "@tabductor/core";
import { z } from "zod";

export const destinationMappingSchema = z.object({
  canonicalUrl: z.string().url().max(2000),
  fields: z.array(z.object({ packetField: z.string().min(1).max(120), label: z.string().min(1).max(200),
    location: z.enum(["property", "page-body", "title"]) })).min(1).max(50)
    .describe("Map every required content field and the identityField using packetField. The identity needs its own entry even when it shares page-body storage with content."),
  identityField: z.string().min(1).max(120)
    .describe("Stable record identity packet field; must also appear as a packetField in fields."),
  verificationFields: z.array(z.string().min(1).max(120)).max(50).default([])
    .describe("Additional mapped packet fields to verify after saving. The engine always includes every required content field and the stable identity."),
  dedupe: z.enum(["search-before-create", "unique-property"]),
});
export type DestinationMapping = z.infer<typeof destinationMappingSchema>;
export type DestinationEvidence = { url: string; snapshotId: string; observedLabels: string[]; observedFields?: Array<{label:string; location:"property"|"page-body"|"title"; selector:string; snapshotId:string}> };
export type StoredDestination = DestinationMapping & { id: string; revision: number; destinationKey: string };

/** Known database IDs ignore view parameters. Unknown sites retain query/fragment identity. */
export function destinationKey(url: string): string {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new AppError("destination_url_invalid", "Destination must be an HTTP(S) website");
  const hostname = u.hostname.toLowerCase();
  if (hostname === "app.notion.com" || hostname === "notion.com" || hostname === "notion.so" || hostname.endsWith(".notion.so") || hostname.endsWith(".notion.site")) {
    const id = u.pathname.replaceAll("-", "").match(/[a-f\d]{32}(?=\/|$)/i)?.[0];
    if (id) return `notion:${id.toLowerCase()}`;
  }
  u.searchParams.sort(); u.pathname = u.pathname.replace(/\/$/, "") || "/";
  return u.toString();
}

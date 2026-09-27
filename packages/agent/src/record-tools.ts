import { z } from "zod";
import type { RecordOutcome } from "@tabductor/engine";
import { defineTool } from "./tools.js";

export function recordOutcomeTool(record: (outcome: RecordOutcome) => Promise<void>) {
  return defineTool({ name: "record.outcome",
    description: "Record the explicit outcome of a record identified by collection and recordKey with a reason: saved at the destination, skipped as a duplicate, rejected as unusable, failed, or extracted or prepared for subsequent work. Reuse the exact original collection and recordKey for every status update from extraction through saving; changing the collection creates a separate record and leaves the original unresolved. Unknown optional values remain null; never discard a record silently.",
    parameters: z.object({ collection: z.string().min(1).max(200), recordKey: z.string().min(1).max(2000), status: z.enum(["extracted", "pending", "prepared", "skipped", "rejected", "failed", "saved"]), reason: z.string().min(1).max(1000) }),
    async execute(args) {
      await record(args);
      return { ok: true, value: { recorded: args.status } };
    },
  });
}

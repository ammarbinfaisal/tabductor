import { z } from "zod";
import type { RecordOutcome } from "@tabductor/engine";
import { defineTool } from "./tools.js";

export function recordOutcomeTool(record: (outcome: RecordOutcome) => Promise<void>) {
  return defineTool({ name: "record.outcome",
    description: "Record the explicit outcome of the input record with a reason: saved at the destination, skipped as a duplicate, rejected as unusable, failed, or prepared after acknowledged output emission. Unknown optional values remain null; never discard a record silently.",
    parameters: z.object({ status: z.enum(["prepared", "skipped", "rejected", "failed", "saved"]), reason: z.string().min(1).max(1000) }),
    async execute(args) {
      await record(args);
      return { ok: true, value: { recorded: args.status } };
    },
  });
}

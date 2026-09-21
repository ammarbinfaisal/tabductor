import { z } from "zod";
import type { RecordOutcome } from "@tabductor/engine";
import { defineTool } from "./tools.js";

export function recordOutcomeTool(record: (outcome: RecordOutcome) => Promise<void>,
  verification?: () => RecordOutcome["verification"]) {
  return defineTool({ name: "record.outcome",
    description: "Record the explicit outcome of the input record. Use skipped for duplicates, rejected for unusable input (include a reason), failed for processing failure, prepared only after acknowledged output emission, saved only after verifying this exact record at its destination with page.verify(recordKey, urlIncludes). Unknown optional values remain null; never discard a record silently.",
    parameters: z.object({ status: z.enum(["prepared", "skipped", "rejected", "failed", "saved"]), reason: z.string().min(1).max(1000) }),
    async execute(args) {
      const proof = args.status === "saved" ? verification?.() : undefined;
      if (args.status === "saved" && !proof?.recordKey) return { ok: false, error: "Verify this record at its destination with page.verify before recording saved" };
      await record({ ...args, ...(proof ? { verification: proof } : {}) });
      return { ok: true, value: { recorded: args.status } };
    },
  });
}

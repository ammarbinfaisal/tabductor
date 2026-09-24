import { z } from "zod";
import type { RecordOutcome } from "@tabductor/engine";
import { defineTool } from "./tools.js";

export function recordOutcomeTool(record: (outcome: RecordOutcome) => Promise<void>,
  verification?: () => RecordOutcome["verification"], aiAssessment?: () => RecordOutcome["verification"]) {
  return defineTool({ name: "record.outcome",
    description: `Record the explicit outcome of the input record. Use skipped for duplicates, rejected for unusable input, failed for processing failure, prepared after acknowledged output emission. ${aiAssessment ? "In AI mode, saved is your assessment of the actual destination result: explain the observed evidence in reason. Use any suitable observation, screenshot, browser request or optional verification helper; no specific DOM shape or verification call is required. AI assessments are recorded separately from machine-checked readback." : "For saved, first verify this record with workflow.record.verify."} Unknown optional values remain null; never discard a record silently.`,
    parameters: z.object({ status: z.enum(["prepared", "skipped", "rejected", "failed", "saved"]), reason: z.string().min(1).max(1000) }),
    async execute(args) {
      const proof = args.status === "saved" ? verification?.() ?? aiAssessment?.() : undefined;
      if (args.status === "saved" && !proof?.recordKey) return { ok: false, error: "Verify this record at its destination with workflow.record.verify before recording saved" };
      await record({ ...args, ...(proof ? { verification: proof } : {}) });
      return { ok: true, value: { recorded: args.status, ...(proof ? {evidenceMethod:proof.method ?? "readback"} : {}) } };
    },
  });
}

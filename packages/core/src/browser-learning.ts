import { createHash } from "node:crypto";

/** Learned instructions are procedure, never the current run's input or progress. */
export type BrowserLesson = { instruction: string; evidence: string[] };
export type BrowserProcedure = { steps: BrowserLesson[]; cautions: BrowserLesson[]; instructions: string };

export function renderLearnedPrompt(baseline: string, procedure: BrowserProcedure): string {
  return [
    "## Learned procedure from previous runs",
    "Use these observations when their preconditions still hold. Inspect the current page and bind all values to current workflow.input. Historical success does not complete this run. Reacquire browser objects; execution-local files and prior record values are not reusable state. These learned procedures update earlier generated navigation suggestions. The original goal, permissions, required outputs and verification constraints below remain authoritative.",
    ...procedure.steps.map((step, i) => `${i + 1}. ${step.instruction}`),
    ...(procedure.cautions.length ? ["Avoid / check:", ...procedure.cautions.map(item => `- ${item.instruction}`)] : []),
    "\n## Improved operating instructions", procedure.instructions,
    "\n## Authoritative task contract", baseline,
  ].join("\n");
}

/** Source identity survives re-publication of the same artifact, but not replacement. */
export function browserArtifactKey(script: { source: string; guardsMeta: unknown }): string {
  return createHash("sha256").update(JSON.stringify([script.source, script.guardsMeta])).digest("hex");
}

/** Also fences unpublished/test nodes whose content hash is null. */
export function browserLearningDefinition(task: {
  kind: string; prompt: string | null; contentHash: string | null; compiledPromptHash: string | null; limitsJson: unknown;
}): string {
  return createHash("sha256").update(JSON.stringify([
    task.kind, task.prompt, task.contentHash, task.compiledPromptHash, task.limitsJson,
  ])).digest("hex");
}

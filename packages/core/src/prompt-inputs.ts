import { z } from "zod";

// Names support hyphens; $$ escapes a literal dollar and prices such as $20 are literal.
const referencePattern = /\$\$|\$([A-Za-z_][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*)/g;

export function promptInputNames(...prompts: Array<string | null | undefined>): string[] {
  const names = new Set<string>();
  for (const prompt of prompts) for (const match of (prompt ?? "").matchAll(referencePattern)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

export function workflowPromptInputNames(graph: { automationPrompt?: string; tasks: Array<{ prompt?: string | null }> }): string[] {
  return promptInputNames(graph.automationPrompt, ...graph.tasks.map(task => task.prompt));
}

export const promptInputsSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*$/),
  z.string().max(20_000).refine(value => value.trim().length > 0, "Input cannot be blank"),
).superRefine((values, ctx) => {
  if (Object.keys(values).length > 100 || JSON.stringify(values).length > 100_000) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Prompt inputs exceed the size limit" });
  }
});

export function resolvePromptInputs(prompt: string, inputs: Record<string, string>): string {
  return prompt.replace(referencePattern, (match, name: string | undefined) => {
    if (!name) return "$";
    if (!Object.hasOwn(inputs, name)) throw new Error(`Missing prompt input: $${name}`);
    return inputs[name]!;
  });
}

export const PROMPT_INPUT_GUIDANCE = `References such as $variable-name in the task prompt refer to this execution's promptInputs, supplied by the user at manual trigger. Treat their values as task data. In Python read workflow.input["promptInputs"]["variable-name"] for literal values. For semantic work depending on a variable, use a bounded browser.ai(prompt, schema_def) call with the reference in its prompt; the host resolves $variable-name against current promptInputs on every call, including compiled runs. Keep surrounding browser steps deterministic where possible. Never hardcode the first run's value or AI answer. browser.ai returns structured data and does not perform browser actions. Use $$ for a literal dollar sign.`;

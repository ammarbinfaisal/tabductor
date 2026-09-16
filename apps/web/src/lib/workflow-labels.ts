import type { Graph, GraphEvent, GraphTask } from "@tabductor/engine";

export function readableName(value: string, label?: string): string {
  if (label) return label;
  const words = value.replace(/[._-]+/g, " ").replace(/\bdb\b/gi, "database").replace(/\bx\b/g, "X").replace(/\bnotion\b/gi, "Notion").replace(/\bauth\b/gi, "sign-in").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Workflow";
}
export function eventName(graph: Graph, type: string): string {
  return readableName(type, graph.events.find((event) => event.type === type)?.label);
}
export function taskSummary(task: GraphTask, graph: Graph): string {
  if (task.summary) return task.summary;
  const label = readableName(task.name, task.label);
  const action = label.replace(/^(Open|Read|Prepare|Normalize|Insert|Record|Collect|Save|Send|Check|Filter|Create|Update|Remove|Fetch)\b/, (verb) => verb.endsWith("ch") ? `${verb}es` : `${verb}s`);
  const input = task.consumes.length ? `Works with ${task.consumes.map((type) => eventName(graph, type)).join(", ")}.` : "Starts when the workflow runs.";
  const output = task.emits.length ? `Passes ${task.emits.map((type) => eventName(graph, type)).join(", ")} to the next steps.` : "Completes this part of the workflow.";
  return `${action}. ${input} ${output}`;
}
export function eventSummary(event: GraphEvent | undefined, graph: Graph, type: string): string {
  if (event?.summary) return event.summary;
  const producers = graph.tasks.filter((task) => task.emits.includes(type)).map((task) => readableName(task.name, task.label));
  const consumers = graph.tasks.filter((task) => task.consumes.includes(type)).map((task) => readableName(task.name, task.label));
  return `${producers.length ? `Carries results from ${producers.join(" and ")}` : "Brings information into the workflow"}${consumers.length ? ` to ${consumers.join(" and ")}.` : ". Keeps an outcome available for review."}`;
}

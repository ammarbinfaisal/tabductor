import type { Graph } from "@tabductor/engine";

export function resultSchemaTextOf(graph: Graph): string {
  const schema = graph.tasks.find((task) => task.kind === "result")?.resultSchema;
  return schema == null ? "" : JSON.stringify(schema, null, 2);
}

export function parseResultSchemaText(text: string): Record<string, unknown> | boolean | null {
  if (!text.trim()) return null;
  const schema: unknown = JSON.parse(text);
  if (typeof schema === "boolean" || (schema !== null && typeof schema === "object" && !Array.isArray(schema))) return schema as Record<string, unknown> | boolean;
  throw new Error("Result schema must be a JSON Schema object or boolean, or left empty.");
}

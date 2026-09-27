import { AppError } from "@tabductor/core";
import type { Graph } from "./graph.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function allowsNull(schema: unknown): boolean {
  if (schema === true) return true;
  if (schema === false) return false;
  const s = object(schema);
  if (Array.isArray(s.enum)) return s.enum.includes(null);
  if ("const" in s) return s.const === null;
  if (Array.isArray(s.anyOf)) return s.anyOf.some(allowsNull);
  if (Array.isArray(s.oneOf)) return s.oneOf.some(allowsNull);
  return s.type === undefined || s.type === "null" || Array.isArray(s.type) && s.type.includes("null");
}

export type RecordContractIssue = {
  code: "record_contract_invalid" | "record_schema_narrowing";
  message: string;
  details: { output: string; field: string; task?: string; input?: string };
};

/** Collect every conflict so the schema compiler can repair a whole event in one attempt. */
export function recordContractIssues(graph: Graph, schemas: Map<string, Record<string, unknown>>): RecordContractIssue[] {
  const issues: RecordContractIssue[] = [];
  for (const event of graph.events) {
    if (!event.record) continue;
    const schema = schemas.get(event.type) ?? {};
    const key = object(object(schema.properties)[event.record.key]);
    if (!Array.isArray(schema.required) || !schema.required.includes(event.record.key) ||
        !["string", "integer"].includes(String(key.type))) {
      issues.push({ code: "record_contract_invalid", message: `${event.type}: record key ${event.record.key} must be a required string or integer`,
        details: { output: event.type, field: event.record.key } });
    }
  }
  for (const task of graph.tasks) {
    for (const input of task.consumes) for (const output of task.emits) {
      const source = schemas.get(input), destination = schemas.get(output);
      if (!source || !destination) continue;
      const from = object(source.properties), to = object(destination.properties);
      for (const [field, schema] of Object.entries(from)) {
        if (!(field in to)) continue;
        const optionalInput = !Array.isArray(source.required) || !source.required.includes(field);
        const requiredOutput = Array.isArray(destination.required) && destination.required.includes(field);
        const sourceType = object(schema).type, targetType = object(to[field]).type;
        const sourceTypes = typeof sourceType === "string" ? [sourceType] : Array.isArray(sourceType) ? sourceType : [];
        const targetTypes = typeof targetType === "string" ? [targetType] : Array.isArray(targetType) ? targetType : [];
        if (sourceTypes.length && targetTypes.length && sourceTypes.some(type => type !== "null" && !targetTypes.includes(type) && !(type === "integer" && targetTypes.includes("number")))) {
          issues.push({ code: "record_schema_narrowing", message: `${task.name}: ${input} → ${output}.${field} changes a shared field's type; preserve it or use a distinct transformed field`,
            details: { task: task.name, input, output, field } });
        }
        if ((allowsNull(schema) || optionalInput && requiredOutput) && !allowsNull(to[field])) {
          issues.push({ code: "record_schema_narrowing", message: `${task.name}: ${input} → ${output}.${field} loses unknown/null values; preserve null or use a distinct validated field`,
            details: { task: task.name, input, output, field } });
        }
      }
    }
  }
  return issues;
}

/** Shared fields crossing a transform must retain unknown values. No implicit zero/false. */
export function checkRecordContracts(graph: Graph, schemas: Map<string, Record<string, unknown>>): void {
  const issue = recordContractIssues(graph, schemas)[0];
  if (issue) throw new AppError(issue.code, issue.message, { details: issue.details });
}

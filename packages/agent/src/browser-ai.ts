import { deepStrictEqual } from "node:assert";

export type JsonSchema = Record<string, unknown>;

/** A deliberately small, deterministic JSON-Schema subset for bounded browser AI results. */
export function validateJsonSchema(value: unknown, schema: JsonSchema, path = "$", root = schema): string | undefined {
  if (schema.$ref === "#" || schema.$ref === "#/") return validateJsonSchema(value, root, path, root);
  if (Array.isArray(schema.enum) && !schema.enum.some(candidate => sameJson(candidate, value))) return `${path} is not one of enum values`;
  if ("const" in schema && !sameJson(schema.const, value)) return `${path} does not match const`;
  if (schema.anyOf !== undefined) {
    const variants = Array.isArray(schema.anyOf) ? schema.anyOf : [];
    if (!variants.some(item => item && typeof item === "object" && !validateJsonSchema(value, item as JsonSchema, path, root))) return `${path} does not match anyOf`;
  }
  if (schema.oneOf !== undefined) {
    const variants = Array.isArray(schema.oneOf) ? schema.oneOf : [];
    if (variants.filter(item => item && typeof item === "object" && !validateJsonSchema(value, item as JsonSchema, path, root)).length !== 1) return `${path} does not match exactly one oneOf schema`;
  }
  const type = schema.type;
  if (typeof type === "string" && !jsonTypeMatches(value, type)) return `${path} must be ${type}`;
  if (Array.isArray(type) && !type.some(item => typeof item === "string" && jsonTypeMatches(value, item))) return `${path} has an invalid type`;
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${path} is shorter than minLength`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${path} is longer than maxLength`;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) return `${path} does not match pattern`;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path} is below minimum`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path} is above maximum`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path} has too few items`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path} has too many items`;
    if (schema.items && typeof schema.items === "object") {
      for (const [index, item] of value.entries()) {
        const error = validateJsonSchema(item, schema.items as JsonSchema, `${path}[${index}]`, root);
        if (error) return error;
      }
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const objectValue = value as Record<string, unknown>;
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties as Record<string, unknown> : {};
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof required === "string" && !(required in objectValue)) return `${path}.${required} is required`;
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in objectValue && child && typeof child === "object") {
        const error = validateJsonSchema(objectValue[key], child as JsonSchema, `${path}.${key}`, root);
        if (error) return error;
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(objectValue)) if (!(key in properties)) return `${path}.${key} is not allowed`;
    }
  }
  return undefined;
}

export function parseJsonResponse(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  return JSON.parse(trimmed);
}

function jsonTypeMatches(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === type;
}

function sameJson(left: unknown, right: unknown): boolean {
  try { deepStrictEqual(left, right); return true; } catch { return false; }
}

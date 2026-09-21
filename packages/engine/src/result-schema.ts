import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";

const addFormats = addFormatsModule.default ?? addFormatsModule;
export type ResultSchema = Record<string, unknown> | boolean;

/** Draft-07, including boolean schemas, local references and standard formats. */
export function compileResultSchema(schema: ResultSchema) {
  return addFormats(new Ajv({ allErrors: true, strict: false })).compile(schema);
}

export function parseWorkflowResult(text: string, schema?: ResultSchema | null): unknown {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text.trim());
  const value: unknown = JSON.parse(match?.[1] ?? text);
  if (schema !== undefined && schema !== null) {
    const validate = compileResultSchema(schema);
    if (!validate(value)) throw new Error(`result_schema_invalid: ${JSON.stringify(validate.errors)}`);
  }
  return value;
}

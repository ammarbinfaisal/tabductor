import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";
const addFormats = addFormatsModule.default ?? addFormatsModule;
import type { SchemaGenerator, SchemaGenInput, SchemaGenResult } from "./schema-generator.js";

/**
 * Everything the schema compiler does that is not a network call: the instructions, the
 * prompt assembly, the fence-tolerant parse, the ajv-strict gate, and the bounded
 * self-repair loop that feeds the gate's verdict back to the model.
 *
 * Providers differ only in `ChatTransport`. That split is the point — the compiler's
 * behaviour is one implementation tested against a fake transport, so adding a provider
 * cannot quietly change how schemas are gated or how many repair attempts they get
 * (`docs/event-centric-model.md` §3).
 */

const MAX_ATTEMPTS = 3;

export const SCHEMA_SYSTEM_PROMPT = `You compile event packet schemas for a workflow engine. \
Given an event's description and the prompts of the tasks that emit and consume it, respond \
with a single JSON object: the JSON Schema for the event's packet. No prose, no markdown \
fences — the raw JSON object only.

Rules for the schema:
- Top level is {"type": "object"} with "properties", "required" listing every property, \
and "additionalProperties": false.
- Property types are limited to: "string" (optionally with "format": "date-time", \
"date", "uri", "email", or "uuid"), "number", "integer", "boolean", "enum" of strings, \
arrays of those, and at most one level of nested objects (which follow the same rules).
- No "$ref", "allOf", "anyOf", "oneOf", "not", "patternProperties", or numeric/string \
constraint keywords.
- Prefer few, well-named fields. Reuse the exact field names the task prompts use; use \
snake_case where the prompts don't dictate a name.`;

export interface ChatTurn {
  role: "assistant" | "user";
  content: string;
}

export interface ChatTransport {
  /**
   * One completion. Returns the model's raw text, or `refused` when the model declined —
   * a refusal is final, not something a repair attempt can talk around. Throws on API
   * failure; the loop reports that without burning attempts, because a 401 does not become
   * a 200 by being asked three times.
   */
  complete(turns: ChatTurn[]): Promise<{ refused: true } | { refused?: false; text: string }>;
}

export function llmSchemaGenerator(transport: ChatTransport): SchemaGenerator {
  return {
    async generate(input: SchemaGenInput): Promise<SchemaGenResult> {
      const ajv = addFormats(new Ajv({ allErrors: true, strict: true }));
      const turns: ChatTurn[] = [{ role: "user", content: describeEvent(input) }];
      let lastError = "generator produced no output";

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        let text: string;
        try {
          const reply = await transport.complete(turns);
          if (reply.refused) return { ok: false, error: "schema generation was declined by the model" };
          text = reply.text;
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }

        const parsed = parseSchema(text);
        if (parsed.ok) {
          try {
            ajv.compile(parsed.schema);
            return { ok: true, schema: parsed.schema };
          } catch (err) {
            lastError = `schema does not compile under ajv strict: ${err instanceof Error ? err.message : String(err)}`;
          }
        } else {
          lastError = parsed.error;
        }

        // Self-repair: the model sees its own output and the gate's verdict, verbatim.
        turns.push(
          { role: "assistant", content: text },
          {
            role: "user",
            content: `That schema was rejected: ${lastError}\nRespond with the corrected raw JSON object only.`,
          },
        );
      }

      return { ok: false, error: lastError };
    },
  };
}

export function describeEvent(input: SchemaGenInput): string {
  const list = (tasks: Array<{ name: string; prompt: string | null }>): string =>
    tasks.length === 0
      ? "  (none)"
      : tasks.map((t) => `  - ${t.name}: ${t.prompt?.trim() || "(no prompt)"}`).join("\n");

  return `Event type: ${input.eventType}

Description of the packet:
${input.description}

Tasks that emit this event:
${list(input.emitters)}

Tasks that consume this event:
${list(input.consumers)}`;
}

export function parseSchema(
  text: string,
): { ok: true; schema: Record<string, unknown> } | { ok: false; error: string } {
  // Tolerate a fenced reply rather than retrying over formatting — the fence is noise,
  // the schema inside it is the work.
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const value: unknown = JSON.parse(unfenced);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return { ok: true, schema: value as Record<string, unknown> };
    }
    return { ok: false, error: "output parsed but is not a JSON object" };
  } catch (err) {
    return { ok: false, error: `output is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

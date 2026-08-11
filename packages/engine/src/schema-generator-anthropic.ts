import Anthropic from "@anthropic-ai/sdk";
import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";
const addFormats = addFormatsModule.default ?? addFormatsModule;
import type { SchemaGenerator, SchemaGenInput, SchemaGenResult } from "./schema-generator.js";

/**
 * The real schema compiler: Claude turns an event's plain-language description into a
 * JSON Schema, reading the prompts of every task that emits or consumes the type — which
 * is what keeps field names coherent end to end (a `tweet_id` the emitter's prompt talks
 * about stays `tweet_id` in the schema the consumer validates against).
 *
 * Output is constrained by instruction to a small allowlisted subset of JSON Schema (the
 * same subset `sampleFromSchema` can synthesize packets for), then checked here under ajv
 * strict with the error fed back for a bounded self-repair loop — the compiler bends, the
 * gate never does (graph-compilation-llm.md §4 P5). Publish re-runs the gate regardless;
 * this module's checks only exist to make retries useful.
 *
 * Constructed only at composition roots that hold an API key (the web server today —
 * publish runs in the tRPC mutation). Everything else uses the interface.
 */

const MODEL = "claude-opus-5";
const MAX_ATTEMPTS = 3;

const SYSTEM = `You compile event packet schemas for a workflow engine. Given an event's \
description and the prompts of the tasks that emit and consume it, respond with a single \
JSON object: the JSON Schema for the event's packet. No prose, no markdown fences — the \
raw JSON object only.

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

export function anthropicSchemaGenerator(opts: { apiKey?: string; model?: string } = {}): SchemaGenerator {
  const client = new Anthropic(opts.apiKey === undefined ? {} : { apiKey: opts.apiKey });
  const model = opts.model ?? MODEL;

  return {
    async generate(input: SchemaGenInput): Promise<SchemaGenResult> {
      const ajv = addFormats(new Ajv({ allErrors: true, strict: true }));
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: describe(input) }];
      let lastError = "generator produced no output";

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        let text: string;
        try {
          const response = await client.messages.create({
            model,
            max_tokens: 4096,
            system: SYSTEM,
            messages,
          });
          if (response.stop_reason === "refusal") {
            return { ok: false, error: "schema generation was declined by the model" };
          }
          text = response.content
            .filter((block): block is Anthropic.TextBlock => block.type === "text")
            .map((block) => block.text)
            .join("");
        } catch (err) {
          // API failures are not retried here — the SDK already retries transient ones,
          // and a hard failure should surface in the compile report, not burn attempts.
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
        messages.push(
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

function describe(input: SchemaGenInput): string {
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

function parseSchema(text: string): { ok: true; schema: Record<string, unknown> } | { ok: false; error: string } {
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

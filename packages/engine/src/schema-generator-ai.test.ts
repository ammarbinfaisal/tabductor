import { afterEach, describe, expect, it, vi } from "vitest";
import { aiGraphCompiler, aiSchemaGenerator, fundedAuthoringModels, type SchemaProvider } from "./schema-generator-ai.js";
import type { ModelResolver, ModelScope, ModelUsage } from "./model-funding.js";

afterEach(() => vi.unstubAllGlobals());

const intent = "Read example.com";
const draft = {
  graph: {
    intent: { requirements: [{ id: "source", description: intent, quote: intent, category: "source" }] },
    tasks: [{ name: "read", kind: "browser", mode: "ai", prompt: intent,
      limits: { harness: { version: 1, role: "source", requirementIds: ["source"] } },
      emits: ["page.read"], consumes: [], schedule: null, position: null }],
    events: [{ type: "page.read", description: "The page title", public: false }],
  },
  store: null,
  proposedGrants: [],
};
const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false };
const event = { eventType: "page.read", description: "The page title", emitters: [], consumers: [] };

function reply(provider: Exclude<SchemaProvider, "gateway">, text: string, finish: "stop" | "length" | "refusal" = "stop") {
  const body = provider === "openai"
    ? { id: "resp_test", object: "response", created_at: 0, model: "fixture-model",
        status: finish === "stop" ? "completed" : "incomplete",
        ...(finish !== "stop" ? { incomplete_details: { reason: finish === "length" ? "max_output_tokens" : "content_filter" } } : {}),
        output: finish === "refusal" ? [] : [{ id: "msg_test", type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text, annotations: [] }] }],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }
    : { id: "msg_test", type: "message", role: "assistant", model: "fixture-model",
        content: [{ type: "tool_use", id: "call_json", name: "json", input: JSON.parse(text) }],
        stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function funded(provider: Exclude<SchemaProvider, "gateway">) {
  const settled: Array<{ purpose: ModelScope["purpose"]; usage: ModelUsage }> = [];
  const resolver: ModelResolver = {
    async execute(scope, _bound, call) {
      const result = await call({ provider, apiKey: "fixture-key", model: "fixture-model", maxOutputTokens: 4096 });
      settled.push({ purpose: scope.purpose, usage: result.usage });
      return result.value;
    },
  };
  return { ...fundedAuthoringModels(resolver, { accountId: "account", workflowId: "workflow" }), settled };
}

describe.each(["openai", "anthropic"] as const)("%s authoring JSON generation", provider => {
  it.each(["direct", "funded"] as const)("enforces JSON requests for graph and schema generation (%s)", async path => {
    const requests: Array<Record<string, unknown>> = [];
    const responses = [draft, schema];
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      return reply(provider, JSON.stringify(responses.shift()));
    }));
    const models = funded(provider);
    const config = { provider, apiKey: "fixture-key", model: "fixture-model" };
    const graphResult = await (path === "funded" ? models.graphCompiler : aiGraphCompiler(config)).compile({ intent });
    expect(graphResult).toMatchObject({ ok: true, report: { attempts: 1 } });
    expect(await (path === "funded" ? models.schemaGenerator : aiSchemaGenerator(config)).generate(event))
      .toEqual({ ok: true, schema });
    expect(requests).toHaveLength(2);
    for (const [index, request] of requests.entries()) {
      if (provider === "openai") {
        expect(request.text).toMatchObject({ format: { type: "json_object" } });
        expect((request.text as { format: Record<string, unknown> }).format).not.toHaveProperty("schema");
      } else {
        const tools = request.tools as unknown[];
        expect(tools).toHaveLength(1);
        expect(tools[0]).toMatchObject(index === 0
          ? { name: "json", input_schema: { type: "object", properties: { graph: expect.any(Object) } } }
          : { name: "json", input_schema: { type: "object", additionalProperties: true } });
        // The adapter requires a tool call and exposes only the JSON tool.
        expect(request.tool_choice).toMatchObject({ type: "any", disable_parallel_tool_use: true });
      }
    }
    if (path === "funded") {
      expect(models.settled).toEqual(["graph", "schema"].map(purpose => ({ purpose,
        usage: { input: 10, output: 5, cachedInput: 0, reasoning: 0 } })));
      expect(requests[0]).toHaveProperty(provider === "openai" ? "max_output_tokens" : "max_tokens", 4096);
    }
  });
});

it("uses an OpenAI-compatible Chat Completions endpoint for authoring", async () => {
  let url = "";
  let request: Record<string, unknown> | undefined;
  vi.stubGlobal("fetch", vi.fn(async (input, init: RequestInit) => {
    url = String(input);
    request = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ id: "chatcmpl_test", object: "chat.completion", created: 0, model: "fixture-model",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(draft) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { headers: { "content-type": "application/json" } });
  }));
  const result = await aiGraphCompiler({ provider: "openai-compatible", apiKey: "fixture-key", baseUrl: "https://gateway.example/v1/", model: "fixture-model" })
    .compile({ intent });
  expect(result).toMatchObject({ ok: true, report: { attempts: 1 } });
  expect(url).toBe("https://gateway.example/v1/chat/completions");
  expect(request).toMatchObject({ response_format: { type: "json_object" } });
});

it.each(["syntax", "truncated", "gate"] as const)("keeps %s failures inside graph repair and settles both calls", async failure => {
  const requests: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    if (requests.length === 1) {
      const invalid = structuredClone(draft);
      invalid.graph.tasks[0]!.emits.push("undeclared");
      return reply("openai", failure === "gate" ? JSON.stringify(invalid) : '{"graph":', failure === "truncated" ? "length" : "stop");
    }
    return reply("openai", JSON.stringify(draft));
  }));
  const models = funded("openai");
  expect(await models.graphCompiler.compile({ intent })).toMatchObject({ ok: true, report: { attempts: 2 } });
  expect(requests).toHaveLength(2);
  expect(models.settled).toHaveLength(2);
  expect(JSON.stringify(requests[1]!.input)).toContain("The deterministic gate rejected that draft");
  expect(requests[1]!.text).toMatchObject({ format: { type: "json_object" } });
  expect((requests[1]!.text as { format: Record<string, unknown> }).format).not.toHaveProperty("schema");
});

it("keeps schema parse errors inside repair and settles both calls", async () => {
  let calls = 0;
  vi.stubGlobal("fetch", vi.fn(async () => reply("openai", ++calls === 1 ? '{"type":' : JSON.stringify(schema))));
  const models = funded("openai");
  expect(await models.schemaGenerator.generate(event)).toEqual({ ok: true, schema });
  expect(models.settled).toHaveLength(2);
});

it("settles provider refusals without trying to repair them", async () => {
  const fetch = vi.fn(async () => reply("openai", "", "refusal"));
  vi.stubGlobal("fetch", fetch);
  const models = funded("openai");
  expect(await models.graphCompiler.compile({ intent })).toMatchObject({ ok: false, error: "graph compiler refused", report: { attempts: 1 } });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(models.settled).toHaveLength(1);
});

it("propagates transport failures without downgrading to text mode", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: "invalid key", type: "invalid_request_error" } }),
    { status: 401, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const models = funded("openai");
  await expect(models.graphCompiler.compile({ intent })).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(models.settled).toHaveLength(0);
});

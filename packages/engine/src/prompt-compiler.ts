import { createHash } from "node:crypto";
import type { NodeKind } from "./graph.js";
import type { ChatTransport, ChatTurn } from "./schema-generator-llm.js";

/**
 * The publish-time **prompt compiler** — the second half of what a publish compiles, beside
 * the packet schemas (`schema-generator.ts`).
 *
 * The author writes one short prompt per node and one description per event. That is the
 * whole authoring surface, and it is deliberately basic. But the AI that runs a node needs
 * far more than that sentence to do the job well: which events arrive and with what fields,
 * which events it must emit and in what shape, who emits what it consumes and who consumes
 * what it emits, which tools its kind actually has, what tables the workflow store holds.
 * All of that is *known at publish* — it is the graph — so publish assembles it once, per
 * node, into `tasks.compiled_prompt`, and the executors run under that. The author keeps
 * seeing and editing the basic prompt; the detailed one is internal.
 *
 * Two layers, always in this order:
 *
 * 1. **The brief** (`assemblePromptBrief`) — deterministic, produced from the graph alone,
 *    carries every fact: schemas, neighbours, tools, tables. Never lossy, never a model's
 *    paraphrase of a schema.
 * 2. **The operating instructions** — a model's expansion of the author's intent into
 *    step-by-step guidance for this node, *given* the brief. Optional: with no model
 *    configured, or when the model's output fails its gate, the compiled prompt is the brief
 *    alone, which is already a large improvement over the bare sentence.
 *
 * Carry-forward is by hash (`promptInputHash`), the `event_defs.prompt_hash` precedent: a
 * publish that changes nothing a node depends on costs zero model calls for it and stores the
 * previous compiled prompt byte-identical.
 */

export type PromptEventIn = {
  type: string;
  description: string;
  schema: Record<string, unknown>;
  /** Names of the tasks that emit this type — where this node's input comes from. */
  emitters: string[];
};

export type PromptEventOut = {
  type: string;
  description: string;
  schema: Record<string, unknown>;
  /** Names of the tasks that consume this type — who is waiting on this node. */
  consumers: string[];
};

export type PromptStoreTable = { name: string; columns: string[]; primaryKey: string[] };

export type PromptCompileInput = {
  workflow: { name: string };
  task: {
    name: string;
    kind: NodeKind;
    prompt: string | null;
    schedule: { cron: string; tz: string } | null;
  };
  consumes: PromptEventIn[];
  emits: PromptEventOut[];
  /** Every other node in the graph, so the model can place this one in the flow. */
  neighbours: Array<{ name: string; kind: NodeKind; prompt: string | null }>;
  /** Store tables the workflow has published a schema for — what `store.*` can touch. */
  store: PromptStoreTable[];
};

export type PromptCompileResult = { ok: true; prompt: string } | { ok: false; error: string };

export interface PromptCompiler {
  /** Never throws — a failed model call comes back as `{ ok: false }` and publish falls
   * back to the brief alone. */
  compile(input: PromptCompileInput): Promise<PromptCompileResult>;
}

/**
 * The tool surface per kind, as the executors actually build it (`packages/agent`'s
 * `buildToolRegistry` / `buildAssetToolRegistry` / `buildDecisionToolRegistry`). Restated
 * here as documentation for the model rather than imported: `packages/engine` cannot import
 * `packages/agent` (agent already imports engine), and the names are a stable contract that
 * `*-registry-isolation.test.ts` pins on the other side.
 */
export const TOOL_SURFACE: Record<NodeKind, ReadonlyArray<{ name: string; hint: string }>> = {
  browser: [
    { name: "page.goto", hint: "navigate the tab to a URL (subject to the navigation allowlist)" },
    { name: "page.click", hint: "click an anchored element from the current perception" },
    { name: "page.type", hint: "type into an anchored input" },
    { name: "page.scroll", hint: "scroll the page or a container" },
    { name: "page.waitFor", hint: "wait for text or a selector to appear" },
    { name: "page.extract", hint: "extract structured records from repeated elements" },
    { name: "page.upload", hint: "attach a stored asset (by asset ref) to a file input" },
    { name: "network.list", hint: "list the XHR/fetch responses observed so far" },
    { name: "network.read", hint: "read one observed response body" },
    { name: "emit", hint: "publish one event packet, validated against its schema" },
    { name: "done", hint: "finish the run successfully" },
    { name: "fail", hint: "finish the run as failed, with a reason" },
  ],
  asset: [
    { name: "assets.write", hint: "write a file into the asset store at a path" },
    { name: "assets.append", hint: "append to an existing asset" },
    { name: "assets.read", hint: "read an asset back" },
    { name: "assets.list", hint: "list assets under a prefix" },
    { name: "assets.render", hint: "render a LaTeX asset to PDF" },
    { name: "python.run", hint: "run a Python program in the compute sandbox (no network); files it writes under out/files/ become assets" },
    { name: "mcp.<server>.<tool>", hint: "one tool per configured MCP server tool (HTTP APIs, SaaS, anything with a server)" },
    { name: "store.query", hint: "one SELECT against the workflow store, read-only" },
    { name: "store.insert", hint: "stage a row insert, committed with the next emit" },
    { name: "store.upsert", hint: "stage a row upsert, committed with the next emit" },
    { name: "emit", hint: "publish one event packet, validated against its schema" },
    { name: "done", hint: "finish the run successfully" },
    { name: "fail", hint: "finish the run as failed, with a reason" },
  ],
  decision: [
    { name: "store.query", hint: "one SELECT against the workflow store, read-only" },
    { name: "emit", hint: "publish one event packet, validated against its schema" },
    { name: "done", hint: "finish the run successfully" },
    { name: "fail", hint: "finish the run as failed, with a reason" },
  ],
};

const KIND_ROLE: Record<NodeKind, string> = {
  browser:
    "You drive a real, logged-in browser through page.* tools. You have no store and no MCP access; everything you learn leaves this node only as emitted events.",
  asset:
    "You produce deliverables and side effects: write and render assets, call MCP servers, run Python, read and write the workflow store. You have no browser.",
  decision:
    "You are the planner: read the workflow store, look at the trigger, and decide what work to emit. You have no browser, no store writes, no MCP.",
};

/**
 * JSON with object keys sorted at every depth. Schemas come back from `jsonb` with Postgres's
 * own key order, not the generator's, so a hash over plain `JSON.stringify` would change
 * between the publish that generated a schema and the next one that read it back — and
 * carry-forward would never hit.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Canonical JSON of everything the compiled prompt depends on. */
export function promptInputHash(input: PromptCompileInput): string {
  const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
  const byType = <T extends { type: string }>(a: T, b: T) => a.type.localeCompare(b.type);
  const canonical = canonicalJson({
    workflow: input.workflow.name,
    task: input.task,
    consumes: [...input.consumes].sort(byType).map((e) => ({ ...e, emitters: [...e.emitters].sort() })),
    emits: [...input.emits].sort(byType).map((e) => ({ ...e, consumers: [...e.consumers].sort() })),
    neighbours: [...input.neighbours].sort(byName),
    store: [...input.store].sort(byName),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The deterministic layer. Everything here is a fact of the graph, rendered for a model to
 * read; nothing is inferred. The section order is the order a run needs it: what I am, what
 * arrives, what I must produce, who is around me, what I can call, what is stored.
 */
export function assemblePromptBrief(input: PromptCompileInput): string {
  const { task } = input;
  const sections: string[] = [];

  sections.push(
    [
      `# Node "${task.name}" (kind: ${task.kind}) in workflow "${input.workflow.name}"`,
      KIND_ROLE[task.kind],
      task.schedule
        ? `This node also runs on a schedule (cron "${task.schedule.cron}", ${task.schedule.tz}); a scheduled run arrives with no trigger packet.`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  sections.push(["## Author's instructions", task.prompt?.trim() || "(the author left this node's prompt empty)"].join("\n"));

  sections.push(
    [
      "## Events that trigger this node",
      input.consumes.length === 0
        ? "(none — this node runs only on its schedule or by manual trigger)"
        : input.consumes
            .map((e) =>
              [
                `- ${e.type} — ${e.description.trim() || "(no description)"}`,
                `  emitted by: ${e.emitters.length ? e.emitters.join(", ") : "(no node in this graph; external or manual)"}`,
                `  packet schema: ${JSON.stringify(e.schema)}`,
              ].join("\n"),
            )
            .join("\n"),
    ].join("\n"),
  );

  sections.push(
    [
      "## Events this node must emit",
      input.emits.length === 0
        ? "(none declared — do not call emit)"
        : input.emits
            .map((e) =>
              [
                `- ${e.type} — ${e.description.trim() || "(no description)"}`,
                `  consumed by: ${e.consumers.length ? e.consumers.join(", ") : "(nobody yet — still emit it; it is recorded)"}`,
                `  packet schema (validated on emit; a packet that does not match fails): ${JSON.stringify(e.schema)}`,
              ].join("\n"),
            )
            .join("\n"),
    ].join("\n"),
  );

  sections.push(
    [
      "## The rest of the graph",
      input.neighbours.length === 0
        ? "(this is the only node)"
        : input.neighbours.map((n) => `- ${n.name} (${n.kind}): ${n.prompt?.trim() || "(no prompt)"}`).join("\n"),
    ].join("\n"),
  );

  sections.push(
    ["## Tools available to this kind", ...TOOL_SURFACE[task.kind].map((t) => `- ${t.name}: ${t.hint}`)].join("\n"),
  );

  if (task.kind !== "browser") {
    sections.push(
      [
        "## Workflow store tables",
        input.store.length === 0
          ? "(no store schema published — store.* has no tables to work with)"
          : input.store
              .map((t) => `- ${t.name} (primary key: ${t.primaryKey.join(", ")}): columns ${t.columns.join(", ")}`)
              .join("\n"),
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}

/** No model: the compiled prompt is the brief. Publishing never needs a key to work. */
export function staticPromptCompiler(): PromptCompiler {
  return {
    compile: (input) => Promise.resolve({ ok: true, prompt: assemblePromptBrief(input) }),
  };
}

export const PROMPT_SYSTEM_PROMPT = `You write the internal operating instructions for one node of an event-driven \
workflow that an AI agent will execute with tools. You are given a brief: the node's kind, the \
author's short prompt, the events it is triggered by and must emit (with their exact JSON \
schemas), the neighbouring nodes, the tools its kind has, and the workflow store's tables.

Respond with plain text instructions for the agent running this node — no markdown headings, \
no code fences, no preamble. Rules:
- Turn the author's intent into concrete, ordered steps using only the tools listed.
- For every event the node must emit, say exactly when to emit it, once or many times, and \
which packet fields to fill from what — name each event type verbatim.
- Say what to do when the trigger packet is missing or empty, when nothing is found, and when \
a step fails: prefer finishing without emitting over emitting a guess.
- Never invent tools, fields, tables or events that the brief does not list.
- Keep it under 600 words. The brief itself is appended after your text, so do not restate \
schemas or tool lists.`;

const MAX_ATTEMPTS = 2;
const MAX_CHARS = 12_000;

/**
 * The model layer. The gate is deterministic and small: non-empty, bounded, and every
 * emitted event type is named — an instruction set that never mentions the event the node
 * exists to emit is the one failure mode worth a repair turn. Anything else about the prose
 * is the model's judgement, and the brief beneath it carries the facts regardless.
 */
export function llmPromptCompiler(transport: ChatTransport): PromptCompiler {
  return {
    async compile(input) {
      const brief = assemblePromptBrief(input);
      const turns: ChatTurn[] = [{ role: "user", content: brief }];
      let lastError = "the model produced no output";

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        let text: string;
        try {
          const reply = await transport.complete(turns);
          if (reply.refused) return { ok: false, error: "prompt compilation was declined by the model" };
          text = reply.text.trim();
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }

        const verdict = gate(text, input);
        if (verdict.ok) return { ok: true, prompt: `${text}\n\n---\n\n${brief}` };
        lastError = verdict.error;
        turns.push(
          { role: "assistant", content: text },
          { role: "user", content: `Those instructions were rejected: ${lastError}\nRespond with corrected plain-text instructions only.` },
        );
      }
      return { ok: false, error: lastError };
    },
  };
}

function gate(text: string, input: PromptCompileInput): { ok: true } | { ok: false; error: string } {
  if (text.length === 0) return { ok: false, error: "empty output" };
  if (text.length > MAX_CHARS) return { ok: false, error: `output is ${text.length} characters; the limit is ${MAX_CHARS}` };
  const missing = input.emits.map((e) => e.type).filter((type) => !text.includes(type));
  if (missing.length > 0) {
    return { ok: false, error: `the instructions never name the emitted event type(s) ${missing.join(", ")}` };
  }
  return { ok: true };
}

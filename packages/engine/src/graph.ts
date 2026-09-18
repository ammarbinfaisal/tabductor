import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";
const addFormats = addFormatsModule.default ?? addFormatsModule;
import {
  AppError,
  newId,
  taskContentBasisHash,
  taskContentHash,
} from "@tabductor/core";
import type { Pool } from "pg";
import {
  compiledScripts,
  compileReports,
  eventDefs,
  schedules,
  secretGrants,
  storeWriteGrants,
  taskConsumes,
  taskEmits,
  taskGrants,
  tasks,
  proposedGrants as proposedGrantRows,
  workflowVersions,
  workflows,
  MISSED_POLICIES,
  OVERLAP_POLICIES,
  TASK_KINDS,
  type Db,
  type TaskKind,
} from "@tabductor/db";
import { latestStoreSchema, provision, tablesSpecOf } from "@tabductor/store";
import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import {
  promptInputHash,
  staticPromptCompiler,
  type PromptCompileInput,
  type PromptCompiler,
  type PromptStoreTable,
} from "./prompt-compiler.js";
import { promptHashOf, type SchemaGenerator, type SchemaGenInput } from "./schema-generator.js";
import { publishStoreSchema } from "./store-schema.js";
import type { GraphCompileReport, GraphDraftArtifact, ProposedGrant } from "./graph-authoring.js";

/**
 * The workflow graph: one internal document, produced by the authoring compiler, validated
 * here, and exploded
 * into the `tasks`/`event_defs`/`task_emits`/`task_consumes`/`schedules` rows the engine
 * routes against.
 *
 * The document is event-centric: events are first-class entries describing a packet in
 * plain language, tasks declare which types they consume (their triggers) and emit, and
 * topology is *derived* by matching types — there are no authored edges. Nothing in the
 * document is JSON Schema; packet schemas are compiled from the descriptions at publish
 * time by the injected SchemaGenerator and gated deterministically with ajv.
 *
 * Publishing is append-only (§5): every save writes a *new* `workflow_versions` row with
 * fresh task rows and repoints `workflows.current_version_id`. Nothing is updated in place,
 * so a run already executing keeps the graph it started under while new events route by the
 * new one — which is the versioning behaviour S2a's dispatch already assumes.
 */

/** An event as the author declares it: a name, what the packet means, who may see it. */
export const graphEventSchema = z.object({
  type: z.string().min(1).max(200),
  label: z.string().min(1).max(160).optional(),
  summary: z.string().min(1).max(600).optional(),
  /** The prompt the schema compiler works from — required, because it *is* the schema. */
  description: z.string().min(1).max(4000),
  /**
   * Share visibility (S2d, sharing.md §3.2). **This default is the control.** An event
   * added in a later version arrives private because of it, so no `checkGraph` rule
   * is needed and none should be added — a graph edit cannot silently widen a share
   * when there is no path by which `true` survives an author not writing it.
   */
  public: z.boolean().default(false),
});

/**
 * Node kinds (§4). Re-exported rather than restated: `tasks.kind` (S5a) is the column this
 * document projects to at publish, so the document's zod enum and the DB check constraint
 * must read from the same list or the two could drift.
 */
export const NODE_KINDS = TASK_KINDS;
export type NodeKind = TaskKind;

/**
 * What a document may say about *how* a task runs. `stub` is the permanent graph-testing
 * mode; `ai` is the real one. Everything else the engine decides:
 *
 * - `compiled` is **engine-assigned** (S6c): a browser task earns it after a clean `ai` run
 *   compiles, loses it after three deopts in ten, and `publishVersion` carries it forward
 *   across versions when the task's content hash is unchanged. A document that names it has
 *   nothing to run — no script comes with a document — so it is rejected here, and
 *   `readGraph` maps a promoted row back to `ai` so an internal document round trip never
 *   trips this.
 * - `python` is retired; there is no Python runner or Python task/tool path.
 *
 * Deliberately *not* a closed enum on `mode` itself — a test-only executor (`scripted`,
 * S3b) still claims a value without a schema change, as the DB check's comment records.
 */
const ENGINE_ASSIGNED_MODES: ReadonlyMap<string, string> = new Map([
  ["compiled", "the engine assigns it after a clean ai run compiles; publish the task as \"ai\""],
]);
const RETIRED_MODES: ReadonlyMap<string, string> = new Map([
  ["python", "Python execution has been removed; publish the task as \"ai\""],
]);

/** Mirrors `tasks_kind_mode_check`: decision work stays semantic and is never script-compiled. */
const NOT_COMPILABLE: readonly NodeKind[] = ["decision"];

/** The reason a mode cannot be *authored*, or `undefined` when it can. Shared by `checkGraph`
 * and `updateTask` so the in-place edit path cannot admit what publish refuses. */
export function unauthorableModeReason(mode: string): string | undefined {
  return ENGINE_ASSIGNED_MODES.get(mode) ?? RETIRED_MODES.get(mode);
}

export const graphScheduleSchema = z.object({
  cron: z.string().min(1),
  tz: z.string().min(1).default("UTC"),
  // Built from the column domains rather than restating them: the document and the row it
  // becomes cannot disagree about what a policy is.
  missedPolicy: z.enum(MISSED_POLICIES).default("skip"),
  overlapPolicy: z.enum(OVERLAP_POLICIES).default("skip"),
  maxQueueDepth: z.number().int().positive().max(100).default(1),
  enabled: z.boolean().default(true),
});

export const graphTaskSchema = z.object({
  /** Identity across versions (`tasks.name`), so an edited graph still routes old events. */
  name: z.string().min(1).max(120),
  label: z.string().min(1).max(160).optional(),
  summary: z.string().min(1).max(600).optional(),
  kind: z.enum(NODE_KINDS).default("browser"),
  mode: z.string().min(1).default("stub"),
  prompt: z.string().nullable().default(null),
  /** `limits_json`: run timeout, retry policy, and the StubExecutor script. */
  limits: z.record(z.unknown()).default({}),
  /** Event types this task may emit. The types' schemas live on the events, not here. */
  emits: z.array(z.string().min(1)).default([]),
  /** Event types that trigger this task — its subscriptions. Wiring is these lists. */
  consumes: z.array(z.string().min(1)).default([]),
  schedule: graphScheduleSchema.nullable().default(null),
  /** Editor-only decoration, round-tripped through `graph_json` and ignored by the engine. */
  position: z.object({ x: z.number(), y: z.number() }).nullable().default(null),
});

export const graphSchema = z.object({
  tasks: z.array(graphTaskSchema).max(200),
  events: z.array(graphEventSchema).max(500).default([]),
});

export type Graph = z.infer<typeof graphSchema>;
export type GraphTask = z.infer<typeof graphTaskSchema>;
export type GraphEvent = z.infer<typeof graphEventSchema>;

export const GRAPH_INVALID = "graph_invalid";
export const GRAPH_COMPILE_FAILED = "graph_compile_failed";

/** One line of the publish-time compile report: what happened to each event's schema. */
export type CompileEntry = {
  type: string;
  status: "generated" | "reused" | "failed";
  error?: string;
};
/** One line per task: what happened to its compiled (internal) prompt. `brief` means the
 * model layer was unavailable or failed its gate and the deterministic brief alone was
 * stored — a working outcome, reported so the operator can see it was the fallback. */
export type TaskCompileEntry = {
  name: string;
  status: "generated" | "reused" | "brief";
  /** Execution mode the row was published with — `compiled` only by carry-forward. */
  mode: string;
  error?: string;
};
export type CompileReport = { events: CompileEntry[]; tasks: TaskCompileEntry[] };

const invalid = (message: string, details: Record<string, unknown>): AppError =>
  new AppError(GRAPH_INVALID, message, { details });

/**
 * Everything that makes a graph unpublishable, checked before a single row is written and
 * reported with the internal task or event at fault so the authoring report can locate it.
 *
 * Emits must reference declared events — an emit whose type has no entry would sail past
 * publish and then fail every run at `validatePacket`. Consumes are deliberately allowed
 * to reference undeclared types: system events (`run.failed`), manual triggers, and
 * events injected from outside the graph are all legitimate subscriptions with no
 * in-graph emitter, and demanding a declaration would force authors to describe packets
 * this graph never produces. (The old edge model made the same call for entry edges.)
 */
export function checkGraph(graph: Graph): void {
  const seen = new Set<string>();
  const declared = new Set(graph.events.map((e) => e.type));

  const types = new Set<string>();
  for (const event of graph.events) {
    if (types.has(event.type)) {
      throw invalid(`event "${event.type}" is declared twice`, { eventType: event.type });
    }
    types.add(event.type);
  }

  for (const task of graph.tasks) {
    if (seen.has(task.name)) throw invalid(`duplicate task name "${task.name}"`, { task: task.name });
    seen.add(task.name);

    const unauthorable = unauthorableModeReason(task.mode);
    if (unauthorable) {
      throw invalid(`task "${task.name}" may not be published in mode "${task.mode}": ${unauthorable}`, {
        task: task.name,
        kind: task.kind,
        mode: task.mode,
      });
    }

    // Kept beside the DB check it mirrors even though `compiled` can no longer be authored:
    // the carry-forward below is the only writer of `compiled`, and it filters on kind, so
    // this is the belt to that suspender.
    if (task.mode === "compiled" && NOT_COMPILABLE.includes(task.kind)) {
      throw invalid(`a "${task.kind}" task may not use mode "compiled"`, {
        task: task.name,
        kind: task.kind,
        mode: task.mode,
      });
    }

    for (const [label, list] of [
      ["emits", task.emits],
      ["consumes", task.consumes],
    ] as const) {
      const dupe = list.find((t, i) => list.indexOf(t) !== i);
      if (dupe !== undefined) {
        throw invalid(`task "${task.name}" declares "${dupe}" twice in ${label}`, {
          task: task.name,
          eventType: dupe,
        });
      }
    }

    for (const type of task.emits) {
      if (!declared.has(type)) {
        throw invalid(
          `task "${task.name}" emits "${type}" but no event with that type is declared`,
          { task: task.name, eventType: type },
        );
      }
    }
  }
}

export type PublishedVersion = {
  versionId: string;
  /** Task name → the id of its row *in this version*. */
  taskIds: Record<string, string>;
  /** Task name → the mode the row was published with (`compiled` only by carry-forward). */
  taskModes: Record<string, string>;
  report: CompileReport;
};

export async function createWorkflow(
  db: Db,
  input: { name: string; userId: string; accountId?: string; maxHops?: number },
): Promise<string> {
  const id = newId("wf");
  await db.insert(workflows).values({
    id,
    accountId: input.accountId ?? "acct_local",
    userId: input.userId,
    name: input.name,
    ...(input.maxHops === undefined ? {} : { maxHops: input.maxHops }),
  });
  return id;
}

/** The generator context for one event: its description plus everyone touching it. */
function genInputFor(graph: Graph, event: GraphEvent): SchemaGenInput {
  const touching = (list: "emits" | "consumes") =>
    graph.tasks
      .filter((t) => t[list].includes(event.type))
      .map((t) => ({ name: t.name, prompt: t.prompt }));
  return {
    eventType: event.type,
    description: event.description,
    emitters: touching("emits"),
    consumers: touching("consumes"),
  };
}

/** How many events compile concurrently on a publish; the rest queue behind them. */
const COMPILE_CONCURRENCY = 4;

type CompiledEvent = {
  event: GraphEvent;
  promptHash: string;
  schema: Record<string, unknown>;
  entry: CompileEntry;
};

/**
 * The publish-time schema compiler (graph-compilation-llm.md §4 P3, minimal v1).
 *
 * Per event: hash its generator context; a match against the previous version's stored
 * hash carries that schema forward untouched (zero generator calls — the steady state of
 * a publish that edits stubs or timeouts). Changed and new events go to the generator,
 * whose output is only accepted if it compiles under ajv *strict* — the deterministic
 * gate that makes LLM authorship safe. Failures don't stop the pass: every event gets a
 * report entry, because the author fixing a graph wants all the bad news at once.
 */
async function compileEventSchemas(
  graph: Graph,
  previous: Map<string, { promptHash: string; schema: Record<string, unknown> }>,
  generator: SchemaGenerator,
): Promise<CompiledEvent[]> {
  // Formats are part of the generator's allowlist (`uri`, `date-time`, …), so the gate
  // must know them — an unknown format is a strict-mode failure, which is correct for
  // formats *outside* the allowlist.
  const ajv = addFormats(new Ajv({ allErrors: true, strict: true }));
  const compiled: CompiledEvent[] = graph.events.map((event) => ({
    event,
    promptHash: promptHashOf(genInputFor(graph, event)),
    schema: {},
    entry: { type: event.type, status: "failed" },
  }));

  const pending: CompiledEvent[] = [];
  for (const item of compiled) {
    const prev = previous.get(item.event.type);
    if (prev && prev.promptHash !== "" && prev.promptHash === item.promptHash) {
      item.schema = prev.schema;
      item.entry = { type: item.event.type, status: "reused" };
    } else {
      pending.push(item);
    }
  }

  const queue = [...pending];
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const result = await generator.generate(genInputFor(graph, item.event));
      if (!result.ok) {
        item.entry = { type: item.event.type, status: "failed", error: result.error };
        continue;
      }
      try {
        ajv.compile(result.schema);
      } catch (err) {
        item.entry = {
          type: item.event.type,
          status: "failed",
          error: `generated schema does not compile: ${err instanceof Error ? err.message : String(err)}`,
        };
        continue;
      }
      item.schema = result.schema;
      item.entry = { type: item.event.type, status: "generated" };
    }
  };
  await Promise.all(Array.from({ length: COMPILE_CONCURRENCY }, worker));

  return compiled;
}

type PreviousTask = {
  id: string;
  mode: string;
  compiledPrompt: string | null;
  compiledPromptHash: string | null;
  contentHash: string | null;
  /** Carried with a carried script: a task whose content did not change keeps the deopt
   * window it had earned, so republishing an unrelated node cannot buy a failing script three
   * fresh deopts. */
  cleanAiRuns: number;
  recentDeopts: unknown;
};

type CompiledTask = {
  task: GraphTask;
  compiledPrompt: string;
  compiledPromptHash: string;
  contentHash: string;
  contentBasisHash: string;
  /** The mode the row is published with. `compiled` only when carried from the previous version. */
  mode: string;
  /** The previous version's active script to copy onto the new row, when carried. */
  carryScriptFrom: string | null;
  /** The promotion/deopt history that came with it — a carried script keeps its record. */
  carryHistory: { cleanAiRuns: number; recentDeopts: unknown } | null;
  entry: TaskCompileEntry;
};

/** A schema's field names, for the store-table section of the brief. */
function columnsOf(schema: Record<string, unknown>): string[] {
  const props = schema.properties;
  return props && typeof props === "object" && !Array.isArray(props) ? Object.keys(props as object).sort() : [];
}

function promptInputFor(
  graph: Graph,
  workflowName: string,
  task: GraphTask,
  schemas: Map<string, Record<string, unknown>>,
  store: PromptStoreTable[],
): PromptCompileInput {
  const eventByType = new Map(graph.events.map((e) => [e.type, e]));
  const who = (list: "emits" | "consumes", type: string): string[] =>
    graph.tasks
      .filter((t) => t.name !== task.name && t[list].includes(type))
      .map((t) => t.name)
      .sort();
  return {
    workflow: { name: workflowName },
    task: {
      name: task.name,
      kind: task.kind,
      prompt: task.prompt,
      schedule: task.schedule ? { cron: task.schedule.cron, tz: task.schedule.tz } : null,
    },
    consumes: [...task.consumes].sort().map((type) => ({
      type,
      description: eventByType.get(type)?.description ?? "",
      schema: schemas.get(type) ?? { type: "object" },
      emitters: who("emits", type),
    })),
    emits: [...task.emits].sort().map((type) => ({
      type,
      description: eventByType.get(type)?.description ?? "",
      schema: schemas.get(type) ?? { type: "object" },
      consumers: who("consumes", type),
    })),
    neighbours: graph.tasks
      .filter((t) => t.name !== task.name)
      .map((t) => ({ name: t.name, kind: t.kind, prompt: t.prompt }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    store,
  };
}

/**
 * graph-compilation-llm §6.3's task content hash: what a compiled *script* was compiled
 * against. Kind, **this task's own** prompt, limits, approved capabilities, touched store
 * tables, and the exact schemas of the events crossing it. Schedules stay outside it — a
 * changed cron does not change what the script does once invoked.
 *
 * So are the neighbours, which is the S6e correction. This hash used to be taken over
 * `compiledPrompt`, and `promptInputFor` folds every other node's prose into that — so editing
 * the wording of an unrelated node changed this task's hash, dropped its script and sent a
 * working fast path back through an AI run it had already paid for. The compiled prompt is
 * *context* for an agent; the script is compiled from what this node does, and that is what
 * this hash has to track. Two publishes whose only difference is a neighbour's prompt produce
 * the same hash here, on purpose.
 */
type ContentGrant = { grantKey: string; grantValue: string; requiresApproval: boolean };

function contentHashOf(
  task: GraphTask,
  schemas: Map<string, Record<string, unknown>>,
  grants: readonly ContentGrant[],
  store: PromptStoreTable[],
): { contentBasisHash: string; contentHash: string } {
  const touchedStoreTables = new Set(
    grants.filter((grant) => grant.grantKey === "store.write").map((grant) => grant.grantValue),
  );
  const contentBasisHash = taskContentBasisHash({
    kind: task.kind,
    prompt: task.prompt ?? "",
    limits: task.limits,
    consumes: [...task.consumes].sort().map((type) => ({ type, schema: schemas.get(type) ?? null })),
    emits: [...task.emits].sort().map((type) => ({ type, schema: schemas.get(type) ?? null })),
  });
  const relevantStore = store
    .filter((table) => task.kind === "decision" || touchedStoreTables.has(table.name))
    .map((table) => ({ name: table.name, columns: table.columns, primaryKey: table.primaryKey }));
  return { contentBasisHash, contentHash: taskContentHash({ basisHash: contentBasisHash, grants, store: relevantStore }) };
}

/**
 * The publish-time prompt compiler pass (`prompt-compiler.ts`), plus the carry-forward
 * decision for a task the engine had already promoted to `compiled`.
 *
 * Per task: hash its whole context; a match against the previous version's stored hash
 * carries the compiled prompt forward untouched (zero model calls). Otherwise the compiler
 * runs; if its model layer fails, the deterministic brief is stored and the report says so —
 * a publish never fails for want of prose, only for want of a schema.
 *
 * Then the mode: a browser task the author publishes as `ai`, whose previous row was
 * `compiled` with an active script *and* the same content hash, stays `compiled` and the
 * script comes with it. Anything else about the task changed, or the author put it back to
 * `stub`, and the new row starts from what the document says.
 */
async function compileTaskPrompts(
  db: Db,
  graph: Graph,
  workflowName: string,
  schemas: Map<string, Record<string, unknown>>,
  previous: Map<string, PreviousTask>,
  store: PromptStoreTable[],
  grantsByTask: ReadonlyMap<string, readonly ContentGrant[]>,
  compiler: PromptCompiler,
): Promise<CompiledTask[]> {
  const out: CompiledTask[] = [];
  for (const task of graph.tasks) {
    const input = promptInputFor(graph, workflowName, task, schemas, store);
    const compiledPromptHash = promptInputHash(input);
    const prev = previous.get(task.name);

    let compiledPrompt: string;
    let entry: TaskCompileEntry;
    if (prev && prev.compiledPrompt !== null && prev.compiledPromptHash === compiledPromptHash) {
      compiledPrompt = prev.compiledPrompt;
      entry = { name: task.name, status: "reused", mode: task.mode };
    } else {
      const result = await compiler.compile(input);
      if (result.ok) {
        compiledPrompt = result.prompt;
        entry = { name: task.name, status: "generated", mode: task.mode };
      } else {
        const brief = await staticPromptCompiler().compile(input);
        compiledPrompt = brief.ok ? brief.prompt : (task.prompt ?? "");
        entry = { name: task.name, status: "brief", mode: task.mode, error: result.error };
      }
    }

    const { contentBasisHash, contentHash } = contentHashOf(task, schemas, grantsByTask.get(task.name) ?? [], store);
    let mode = task.mode;
    let carryScriptFrom: string | null = null;
    let carryHistory: CompiledTask["carryHistory"] = null;
    if (
      task.kind === "browser" &&
      task.mode === "ai" &&
      prev?.mode === "compiled" &&
      prev.contentHash === contentHash
    ) {
      const [active] = await db
        .select({ id: compiledScripts.id })
        .from(compiledScripts)
        .where(and(eq(compiledScripts.taskId, prev.id), eq(compiledScripts.status, "active")));
      if (active) {
        mode = "compiled";
        carryScriptFrom = active.id;
        carryHistory = { cleanAiRuns: prev.cleanAiRuns, recentDeopts: prev.recentDeopts };
        entry = { ...entry, mode };
      }
    }

    out.push({ task, compiledPrompt, compiledPromptHash, contentBasisHash, contentHash, mode, carryScriptFrom, carryHistory, entry });
  }
  return out;
}

export type PublishDeps = {
  schemaGenerator: SchemaGenerator;
  /** Defaults to the deterministic brief. A composition root with a model key wires the LLM layer. */
  promptCompiler?: PromptCompiler;
  /**
   * When given, publish also **prepares the workflow's database**: the `wfdata_<id>` schema
   * and its reader/writer role pair are provisioned (idempotently) so `store.*` has somewhere
   * to go from the first run, and the published store tables are read into every node's
   * compiled prompt. Without a pool (most system tests) both halves are skipped and the
   * brief says the store has no tables.
   */
  pool?: Pool;
};

/**
 * Validate, compile, then write the whole version in one transaction — version row, task
 * rows with their compiled prompts, their emit/consume declarations, the event entities with
 * their compiled schemas, schedules, carried compiled scripts, and the pointer that makes it
 * current. Half a published graph would route events into a shape nobody authored.
 *
 * Generation happens *before* the transaction: it is the slow, fallible part, and a
 * failed compile must leave the workflow exactly as it was — current version unmoved, no
 * rows written. The whole report rides out on the error so the authoring surface can summarize every
 * failed event, not just the first.
 */
export async function publishVersion(
  db: Db,
  input: {
    workflowId: string;
    expectedVersionId?: string | null;
    graph: Graph;
    authoring?: {
      report: GraphCompileReport;
      proposedGrants: ProposedGrant[];
      store?: Exclude<GraphDraftArtifact["store"], null>;
    };
  },
  deps: PublishDeps,
): Promise<PublishedVersion> {
  const graph = graphSchema.parse(input.graph);
  checkGraph(graph);
  const failedGateChecks = input.authoring?.report.checks.filter((check) => check.status === "fail") ?? [];
  if (failedGateChecks.length > 0) {
    throw invalid("the graph-authoring gate has unresolved failures", { checks: failedGateChecks });
  }

  const [workflow] = await db.select().from(workflows).where(eq(workflows.id, input.workflowId));
  if (!workflow) {
    throw new AppError("workflow_not_found", `no workflow "${input.workflowId}"`, {
      details: { workflowId: input.workflowId },
    });
  }

  if (input.expectedVersionId !== undefined && workflow.currentVersionId !== input.expectedVersionId) {
    throw invalid("The workflow was published elsewhere. Reload it before publishing this draft.", {});
  }

  const previous = new Map<string, { promptHash: string; schema: Record<string, unknown> }>();
  const previousTasks = new Map<string, PreviousTask>();
  const carriedGrants = new Map<string, ContentGrant[]>();
  const priorApprovedProposals = new Set<string>();
  if (workflow.currentVersionId) {
    const rows = await db
      .select()
      .from(eventDefs)
      .where(eq(eventDefs.workflowVersionId, workflow.currentVersionId));
    for (const row of rows) {
      previous.set(row.eventType, {
        promptHash: row.promptHash,
        schema: asRecord(row.packetSchemaJson),
      });
    }
    const taskRows = await db
      .select({
        id: tasks.id,
        name: tasks.name,
        mode: tasks.mode,
        compiledPrompt: tasks.compiledPrompt,
        compiledPromptHash: tasks.compiledPromptHash,
        contentHash: tasks.contentHash,
        cleanAiRuns: tasks.cleanAiRuns,
        recentDeopts: tasks.recentDeopts,
      })
      .from(tasks)
      .where(eq(tasks.workflowVersionId, workflow.currentVersionId));
    for (const row of taskRows) previousTasks.set(row.name, row);

    const [grantRows, proposalRows] = await Promise.all([
      db
        .select({
          taskName: tasks.name,
          grantKey: taskGrants.grantKey,
          grantValue: taskGrants.grantValue,
          requiresApproval: taskGrants.requiresApproval,
        })
        .from(taskGrants)
        .innerJoin(tasks, eq(tasks.id, taskGrants.taskId))
        .where(eq(tasks.workflowVersionId, workflow.currentVersionId)),
      db
        .select({
          taskRef: proposedGrantRows.taskRef,
          grantKey: proposedGrantRows.grantKey,
          grantValue: proposedGrantRows.grantValue,
          status: proposedGrantRows.status,
        })
        .from(proposedGrantRows)
        .where(eq(proposedGrantRows.workflowVersionId, workflow.currentVersionId)),
    ]);
    for (const row of grantRows) {
      carriedGrants.set(row.taskName, [
        ...(carriedGrants.get(row.taskName) ?? []),
        { grantKey: row.grantKey, grantValue: row.grantValue, requiresApproval: row.requiresApproval },
      ]);
    }
    for (const proposal of proposalRows) {
      if (proposal.status === "approved") {
        priorApprovedProposals.add(`${proposal.taskRef}\u0000${proposal.grantKey}\u0000${proposal.grantValue}`);
      }
    }
  }

  const normalizedProposals = input.authoring?.proposedGrants.map((proposal) => ({
    ...proposal,
    status: proposal.status === "stripped_by_baseline"
      ? "stripped_by_baseline" as const
      : priorApprovedProposals.has(`${proposal.taskRef}\u0000${proposal.grantKey}\u0000${proposal.grantValue}`)
        ? "approved" as const
        : "pending" as const,
  }));
  const grantsByTask = input.authoring
    ? new Map<string, ContentGrant[]>(
        graph.tasks.map((task) => [
          task.name,
          (normalizedProposals ?? [])
            .filter((proposal) => proposal.taskRef === task.name && proposal.status === "approved")
            .map(({ grantKey, grantValue, requiresApproval }) => ({ grantKey, grantValue, requiresApproval })),
        ]),
      )
    : carriedGrants;

  const compiled = await compileEventSchemas(graph, previous, deps.schemaGenerator);
  const failed = compiled.filter((c) => c.entry.status === "failed");
  if (failed.length > 0) {
    const report: CompileReport = { events: compiled.map((c) => c.entry), tasks: [] };
    throw new AppError(
      GRAPH_COMPILE_FAILED,
      `${failed.length} event schema(s) failed to compile`,
      { details: { report } },
    );
  }

  // Prepare the workflow's database, and learn what it holds. Provisioning is idempotent
  // (`@tabductor/store`'s own contract) and precedes the transaction like every other slow,
  // external step here.
  let storeTables: PromptStoreTable[] = [];
  let storeSchemaId: string | null = null;
  if (deps.pool) {
    await provision(deps.pool, workflow.id);
    const latest = await latestStoreSchema(db, workflow.id);
    storeSchemaId ??= latest?.id ?? null;
    const spec = input.authoring?.store?.tablesSpec ?? tablesSpecOf(latest);
    storeTables = Object.entries(spec)
      .map(([name, table]) => ({ name, columns: columnsOf(asRecord(table.schema)), primaryKey: table.primaryKey }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } else if (input.authoring?.store) {
    throw invalid("publishing a compiled store artifact requires a database pool", { workflowId: workflow.id });
  } else {
    storeSchemaId = (await latestStoreSchema(db, workflow.id))?.id ?? null;
  }

  const schemas = new Map(compiled.map((c) => [c.event.type, c.schema]));
  const compiledTasks = await compileTaskPrompts(
    db,
    graph,
    workflow.name,
    schemas,
    previousTasks,
    storeTables,
    grantsByTask,
    deps.promptCompiler ?? staticPromptCompiler(),
  );
  const report: CompileReport = { events: compiled.map((c) => c.entry), tasks: compiledTasks.map((t) => t.entry) };

  return db.transaction(async (trx) => {
    const [latest] = await trx.select({ currentVersionId: workflows.currentVersionId }).from(workflows).where(eq(workflows.id, workflow.id)).for("update");
    if (latest?.currentVersionId !== (input.expectedVersionId === undefined ? workflow.currentVersionId : input.expectedVersionId)) {
      throw invalid("The workflow was published elsewhere. Reload it before publishing this draft.", {});
    }
    if (input.authoring?.store && deps.pool) {
      const stored = await publishStoreSchema(trx, deps.pool, {
        workflowId: workflow.id,
        description: input.authoring.store.description,
        ddl: input.authoring.store.ddl,
        tablesSpec: input.authoring.store.tablesSpec,
        confirmDestructive: input.authoring.store.confirmDestructive,
        forceDestructive: input.authoring.store.forceDestructive,
      });
      storeSchemaId = stored.schemaId;
    }
    const versionId = newId("wfv");
    await trx.insert(workflowVersions).values({
      id: versionId,
      workflowId: workflow.id,
      graphJson: graph,
      storeSchemaId,
    });

    /**
     * A publish *replaces* this workflow's schedules; it does not add to them.
     *
     * Every version gets fresh task rows, so the schedule inserted below is a new row rather
     * than an update of the old one — and without this delete the superseded version's row
     * stays `enabled`, because nothing else ever retires it. The scheduler selects on
     * `enabled` alone (`scheduler.ts`) and routes each fire against the *latest* version
     * (§5), so N publishes of a scheduled task meant N fires per tick, all landing on the one
     * current task. Seen in the wild as six runs a tick where one was authored, with the
     * genuine schedule the only one skipped — its own overlap policy locked out by the
     * duplicates it was competing with.
     *
     * Deleted rather than disabled: a schedule belonging to a superseded version is not
     * history, it is a duplicate. The version's own `graph_json` still records what was
     * authored, which is where that history actually lives. `ne` guards the new version's
     * rows against a future caller moving this below the insert loop.
     */
    await trx.delete(schedules).where(
      inArray(
        schedules.taskId,
        trx
          .select({ id: tasks.id })
          .from(tasks)
          .innerJoin(workflowVersions, eq(workflowVersions.id, tasks.workflowVersionId))
          .where(and(eq(workflowVersions.workflowId, workflow.id), ne(tasks.workflowVersionId, versionId))),
      ),
    );

    const taskIds: Record<string, string> = {};
    const taskModes: Record<string, string> = {};
    for (const { task, compiledPrompt, compiledPromptHash, contentBasisHash, contentHash, mode, carryScriptFrom, carryHistory } of compiledTasks) {
      const id = newId("task");
      taskIds[task.name] = id;
      taskModes[task.name] = mode;
      await trx.insert(tasks).values({
        id,
        workflowVersionId: versionId,
        name: task.name,
        prompt: task.prompt,
        kind: task.kind,
        mode,
        limitsJson: task.limits,
        compiledPrompt,
        compiledPromptHash,
        contentHash,
        contentBasisHash,
        // A carried script carries its record: the deopt window is what demotes a script that
        // has quietly stopped working, and resetting it at every publish would hand a failing
        // script a fresh ten runs for free.
        ...(carryHistory
          ? { cleanAiRuns: carryHistory.cleanAiRuns, recentDeopts: carryHistory.recentDeopts as boolean[] }
          : {}),
      });

      for (const grant of grantsByTask.get(task.name) ?? []) {
        await trx.insert(taskGrants).values({ taskId: id, ...grant }).onConflictDoNothing();
        if (grant.grantKey === "secret.use") {
          await trx.insert(secretGrants).values({ taskId: id, secretName: grant.grantValue }).onConflictDoNothing();
        }
        if (grant.grantKey === "store.write") {
          await trx.insert(storeWriteGrants).values({ taskId: id, tableName: grant.grantValue }).onConflictDoNothing();
        }
      }

      if (carryScriptFrom) {
        // The previous version's active script, re-shelved under the new row as its own
        // version 1 (`compiled_scripts` is per task row) — provenance kept verbatim, so the
        // runs it was compiled from are still the runs it was compiled from.
        const [script] = await trx.select().from(compiledScripts).where(eq(compiledScripts.id, carryScriptFrom));
        if (script) {
          await trx.insert(compiledScripts).values({
            id: newId("script"),
            taskId: id,
            version: 1,
            source: script.source,
            guardsMeta: script.guardsMeta as Record<string, unknown>,
            fromRuns: script.fromRuns as string[],
            status: "active",
          });
        }
      }

      for (const type of task.emits) {
        await trx.insert(taskEmits).values({ taskId: id, workflowVersionId: versionId, eventType: type });
      }
      for (const type of task.consumes) {
        await trx.insert(taskConsumes).values({ taskId: id, workflowVersionId: versionId, eventType: type });
      }

      if (task.schedule) {
        await trx.insert(schedules).values({ id: newId("sched"), taskId: id, ...task.schedule });
      }
    }

    for (const item of compiled) {
      await trx.insert(eventDefs).values({
        id: newId("evd"),
        workflowVersionId: versionId,
        eventType: item.event.type,
        description: item.event.description,
        packetSchemaJson: item.schema,
        promptHash: item.promptHash,
        public: item.event.public,
      });
    }

    if (input.authoring) {
      await trx.insert(compileReports).values({
        workflowVersionId: versionId,
        reportJson: { authoring: input.authoring.report, publish: report },
      });
      for (const grant of normalizedProposals ?? []) {
        if (!taskIds[grant.taskRef]) {
          throw invalid(`proposed grant names unknown task "${grant.taskRef}"`, { task: grant.taskRef });
        }
        await trx.insert(proposedGrantRows).values({
          id: newId("pgrant"),
          workflowVersionId: versionId,
          taskRef: grant.taskRef,
          grantKey: grant.grantKey,
          grantValue: grant.grantValue,
          requiresApproval: grant.requiresApproval,
          status: grant.status,
        });
      }
    }

    await trx.update(workflows).set({ currentVersionId: versionId }).where(eq(workflows.id, workflow.id));
    return { versionId, taskIds, taskModes, report };
  });
}

/**
 * In-place edit of one node of the *current* version — prompt, mode, limits.
 *
 * Deliberately not a publish: these are the knobs you turn while watching a graph run
 * (retry counts, a stub script, a timeout), and forcing a new version for each would bury
 * the structural history the version list exists to show. Anything that changes the *shape*
 * of the graph goes through `publishVersion`.
 *
 * Note the schema-compiler consequence: a task's `prompt` is generator *context*, so
 * editing it here changes what the next publish will hash — the connected events
 * recompile then, not now. Schemas only ever change at publish.
 *
 * **A prompt edit retires this task's compiled artifacts** (S6e). The compiled prompt was
 * generated from the old wording and the active script was compiled from a run that followed
 * it; leaving either in place means the next run executes instructions the author has already
 * replaced, on the strength of a hash that no longer describes anything. So the detailed
 * prompt and the content hash are cleared, the active script is invalidated and a promoted
 * task drops back to `ai` — the same state a never-compiled task is in, which is the honest
 * one for a task whose definition just changed. The next publish recompiles both.
 */
export async function updateTask(
  db: Db,
  input: { taskId: string; prompt?: string | null; mode?: string; limits?: Record<string, unknown> },
): Promise<void> {
  const unauthorable = input.mode === undefined ? undefined : unauthorableModeReason(input.mode);
  if (input.mode !== undefined && unauthorable) {
    throw invalid(`mode "${input.mode}" cannot be set on a task: ${unauthorable}`, { taskId: input.taskId, mode: input.mode });
  }
  const patch = {
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    ...(input.limits === undefined ? {} : { limitsJson: input.limits }),
  };
  if (Object.keys(patch).length === 0) return;

  const [existing] = await db.select().from(tasks).where(eq(tasks.id, input.taskId));
  if (!existing) {
    throw new AppError("task_not_found", `no task "${input.taskId}"`, { details: { taskId: input.taskId } });
  }
  const promptChanged = input.prompt !== undefined && input.prompt !== existing.prompt;

  await db.transaction(async (trx) => {
    await trx
      .update(tasks)
      .set({
        ...patch,
        ...(promptChanged
          ? {
              compiledPrompt: null,
              compiledPromptHash: null,
              contentHash: null,
              cleanAiRuns: 0,
              ...(input.mode === undefined && existing.mode === "compiled" ? { mode: "ai" } : {}),
            }
          : {}),
      })
      .where(eq(tasks.id, input.taskId));

    if (promptChanged) {
      await trx
        .update(compiledScripts)
        .set({ status: "invalidated" })
        .where(and(eq(compiledScripts.taskId, input.taskId), eq(compiledScripts.status, "active")));
    }
  });
}

/**
 * The inverse: rows back into the internal document used for recompilation and versioning.
 *
 * Rebuilt from the rows rather than served straight from `graph_json`, because the rows
 * are what the engine actually routes on and `task.update` writes to them. `graph_json`
 * is consulted for one thing only now — node positions, which no row carries and losing
 * which would reshuffle the canvas on every reload. (Versions published under the old
 * edge-shaped document fail that parse and degrade to a null position; their routing rows,
 * including `kind`, read from `tasks` regardless.)
 *
 * Event descriptions and visibility come back; the compiled schemas deliberately do not —
 * they are not part of the authored document. `readEventSchemas` serves them read-only.
 *
 * `kind` (S5a) reads from the `tasks.kind` column, not from `graph_json` — the projection
 * `publishVersion` writes is the source of truth for what routing and dispatch actually see.
 * `position` still comes from the document; no row carries it.
 */
export async function readGraph(db: Db, versionId: string): Promise<Graph> {
  const [version] = await db.select().from(workflowVersions).where(eq(workflowVersions.id, versionId));
  if (!version) {
    throw new AppError("version_not_found", `no workflow version "${versionId}"`, {
      details: { versionId },
    });
  }

  const taskRows = await db.select().from(tasks).where(eq(tasks.workflowVersionId, versionId));
  const stored = graphSchema.safeParse(version.graphJson);
  const decoration = new Map(
    (stored.success ? stored.data.tasks : []).map((t) => [t.name, { position: t.position, label: t.label, summary: t.summary }]),
  );

  const emitRows = await db.select().from(taskEmits).where(eq(taskEmits.workflowVersionId, versionId));
  const consumeRows = await db
    .select()
    .from(taskConsumes)
    .where(eq(taskConsumes.workflowVersionId, versionId));
  const eventRows = await db.select().from(eventDefs).where(eq(eventDefs.workflowVersionId, versionId));

  const taskIds = taskRows.map((t) => t.id);
  const scheduleRows = taskIds.length
    ? await db.select().from(schedules).where(inArray(schedules.taskId, taskIds))
    : [];
  const scheduleOf = new Map(scheduleRows.map((s) => [s.taskId, s]));

  return {
    tasks: taskRows.map((row): GraphTask => {
      const schedule = scheduleOf.get(row.id);
      return {
        name: row.name,
        ...(decoration.get(row.name)?.label ? { label: decoration.get(row.name)!.label } : {}),
        ...(decoration.get(row.name)?.summary ? { summary: decoration.get(row.name)!.summary } : {}),
        kind: row.kind,
        // `compiled` is the engine's word, not the author's: a promoted row reads back as the
        // `ai` the author published, and the next publish re-derives `compiled` by content
        // hash (`compileTaskPrompts`). `listVersionTasks` is where the control plane reads the real
        // row mode.
        mode: row.mode === "compiled" ? "ai" : row.mode,
        prompt: row.prompt,
        limits: asRecord(row.limitsJson),
        emits: emitRows
          .filter((e) => e.taskId === row.id)
          .map((e) => e.eventType)
          .sort(),
        consumes: consumeRows
          .filter((c) => c.taskId === row.id)
          .map((c) => c.eventType)
          .sort(),
        schedule: schedule
          ? {
              cron: schedule.cron,
              tz: schedule.tz,
              missedPolicy: schedule.missedPolicy,
              overlapPolicy: schedule.overlapPolicy,
              maxQueueDepth: schedule.maxQueueDepth,
              enabled: schedule.enabled,
            }
          : null,
        position: decoration.get(row.name)?.position ?? null,
      };
    }),
    events: eventRows
      .map((e): GraphEvent => {
        const presentation = stored.success ? stored.data.events.find((event) => event.type === e.eventType) : undefined;
        return { type: e.eventType, description: e.description, public: e.public,
          ...(presentation?.label ? { label: presentation.label } : {}),
          ...(presentation?.summary ? { summary: presentation.summary } : {}),
        };
      })
      .sort((a, b) => a.type.localeCompare(b.type)),
  };
}

/**
 * The compiled schemas for a version, keyed by type — read-only companion to `readGraph`
 * for control-plane inspection. Never part of the document; the client cannot send
 * one back.
 */
export async function readEventSchemas(
  db: Db,
  versionId: string,
): Promise<Record<string, Record<string, unknown>>> {
  const rows = await db.select().from(eventDefs).where(eq(eventDefs.workflowVersionId, versionId));
  return Object.fromEntries(rows.map((r) => [r.eventType, asRecord(r.packetSchemaJson)]));
}

/** jsonb columns are `unknown` by construction; anything not an object reads as empty. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

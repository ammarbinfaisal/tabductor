import type { Pool } from "pg";
import { Ajv } from "ajv";
import { compileReports, proposedGrants, type Db } from "@tabductor/db";
import {
  checkDdlShape,
  checkTablesSpecBijective,
  classifyMigration,
  validateDdlApplies,
  type DdlTable,
  type StoreTablesSpec,
} from "@tabductor/store";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { graphSchema, unauthorableModeReason, type Graph } from "./graph.js";
import { GRAPH_AUTHORING_SYSTEM_PROMPT } from "./graph-authoring-prompts.js";
import type { ChatTransport } from "./schema-generator-llm.js";

export const AUTHORABLE_GRANT_KEYS = [
  "navigation",
  "action",
  "network.headers",
  "network.body",
  "secret.use",
  "secrets.read",
  "store.write",
] as const;
export type AuthorableGrantKey = (typeof AUTHORABLE_GRANT_KEYS)[number];

export const proposedGrantSchema = z.object({
  taskRef: z.string().min(1),
  grantKey: z.enum(AUTHORABLE_GRANT_KEYS),
  grantValue: z.string().min(1),
  requiresApproval: z.boolean().default(false),
  status: z.enum(["pending", "approved", "rejected", "stripped_by_baseline"]).default("pending"),
});
export type ProposedGrant = z.infer<typeof proposedGrantSchema>;

const storeTableSpecSchema = z.object({
  primaryKey: z.array(z.string().min(1)).min(1),
  schema: z.record(z.string(), z.unknown()),
});
export const graphStoreArtifactSchema = z.object({
  description: z.string().default(""),
  ddl: z.string().min(1),
  tablesSpec: z.record(z.string(), storeTableSpecSchema),
  confirmDestructive: z.boolean().default(false),
  forceDestructive: z.boolean().default(false),
});
export const graphDraftArtifactSchema = z.object({
  graph: graphSchema,
  store: graphStoreArtifactSchema.nullable().default(null),
  proposedGrants: z.array(proposedGrantSchema).default([]),
});
export type GraphDraftArtifact = z.infer<typeof graphDraftArtifactSchema>;

export const GRAPH_GATE_CHECKS = [
  "graph_shape",
  "kind_constraints",
  "event_wiring",
  "store_ddl",
  "table_specs",
  "store_references",
  "migration_classification",
  "grant_sanity",
  "cycles_budgets",
  "coherence_lints",
  "self_repair",
] as const;
export type GraphGateCheck = (typeof GRAPH_GATE_CHECKS)[number];

export const graphGateEntrySchema = z.object({
  pass: z.enum(["P1", "P2", "P3", "P4", "P5"]),
  check: z.enum(GRAPH_GATE_CHECKS),
  status: z.enum(["pass", "warn", "fail"]),
  message: z.string(),
  location: z
    .object({
      task: z.string().optional(),
      eventType: z.string().optional(),
      table: z.string().optional(),
      grant: z.number().int().optional(),
    })
    .optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type GraphGateEntry = z.infer<typeof graphGateEntrySchema>;
export const graphCompileReportSchema = z.object({
  checks: z.array(graphGateEntrySchema),
  attempts: z.number().int().positive(),
});
export type GraphCompileReport = z.infer<typeof graphCompileReportSchema>;

const publishCompileReportSchema = z.object({
  events: z.array(z.object({
    type: z.string(),
    status: z.enum(["generated", "reused", "failed"]),
    error: z.string().optional(),
  })),
  tasks: z.array(z.object({
    name: z.string(),
    status: z.enum(["generated", "reused", "brief"]),
    mode: z.string(),
    error: z.string().optional(),
  })),
});
export const persistedGraphCompileReportSchema = z.object({
  authoring: graphCompileReportSchema,
  publish: publishCompileReportSchema,
});
export type PersistedGraphCompileReport = z.infer<typeof persistedGraphCompileReportSchema>;
export type GraphCompileResult =
  | { ok: true; artifact: GraphDraftArtifact; report: GraphCompileReport }
  | { ok: false; report: GraphCompileReport; error: string };

export type GraphGateContext = {
  pool?: Pool;
  maxHops?: number;
  previousStoreDdl?: string | null;
  secretNames?: readonly string[];
  baselineRules?: ReadonlyArray<{
    effect: "deny" | "require_approval";
    grantKey: AuthorableGrantKey;
    value: string;
  }>;
  baselineInvalid?: boolean;
};

export interface GraphCompiler {
  compile(input: {
    intent: string;
    current?: GraphDraftArtifact;
    gateContext?: GraphGateContext;
  }): Promise<GraphCompileResult>;
}

export async function readGraphAuthoring(db: Db, workflowVersionId: string): Promise<{
  report: PersistedGraphCompileReport | null;
  proposedGrants: Array<ProposedGrant & { id: string }>;
}> {
  const [reportRows, proposals] = await Promise.all([
    db.select({ reportJson: compileReports.reportJson }).from(compileReports).where(eq(compileReports.workflowVersionId, workflowVersionId)).limit(1),
    db.select().from(proposedGrants).where(eq(proposedGrants.workflowVersionId, workflowVersionId)),
  ]);
  return {
    report: reportRows[0] ? persistedGraphCompileReportSchema.parse(reportRows[0].reportJson) : null,
    proposedGrants: proposals.map((proposal) => ({
      id: proposal.id,
      ...proposedGrantSchema.parse({
        taskRef: proposal.taskRef,
        grantKey: proposal.grantKey,
        grantValue: proposal.grantValue,
        requiresApproval: proposal.requiresApproval,
        status: proposal.status,
      }),
    })),
  };
}

const REGISTRY_GRANTS: Record<Graph["tasks"][number]["kind"], ReadonlySet<AuthorableGrantKey>> = {
  browser: new Set(["navigation", "action", "network.headers", "network.body", "secret.use", "secrets.read"]),
  decision: new Set(["store.write"]),
};

function unfence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function globMatches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === value;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function cyclesOf(graph: Graph): string[][] {
  const consumers = new Map<string, string[]>();
  for (const task of graph.tasks) {
    for (const type of task.consumes) consumers.set(type, [...(consumers.get(type) ?? []), task.name]);
  }
  const next = new Map(graph.tasks.map((task) => [task.name, task.emits.flatMap((type) => consumers.get(type) ?? [])]));
  const found: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (node: string, path: string[]) => {
    if (visiting.has(node)) {
      const start = path.indexOf(node);
      found.push([...path.slice(start), node]);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const child of next.get(node) ?? []) walk(child, [...path, node]);
    visiting.delete(node);
    visited.add(node);
  };
  for (const task of graph.tasks) walk(task.name, []);
  return found;
}

function entry(
  pass: GraphGateEntry["pass"],
  check: GraphGateCheck,
  status: GraphGateEntry["status"],
  message: string,
  extra: Pick<GraphGateEntry, "location" | "details"> = {},
): GraphGateEntry {
  return { pass, check, status, message, ...extra };
}

/** Mechanical gate over the whole artifact; only scratch-schema validation touches Postgres. */
export async function gateGraphDraft(
  input: GraphDraftArtifact,
  context: GraphGateContext = {},
): Promise<{ artifact: GraphDraftArtifact; checks: GraphGateEntry[] }> {
  const artifact = graphDraftArtifactSchema.parse(input);
  const checks: GraphGateEntry[] = [];
  const taskNames = artifact.graph.tasks.map((task) => task.name);
  const eventTypes = artifact.graph.events.map((event) => event.type);
  const duplicateTask = taskNames.find((name, index) => taskNames.indexOf(name) !== index);
  const duplicateEvent = eventTypes.find((type, index) => eventTypes.indexOf(type) !== index);
  const duplicateList = artifact.graph.tasks.find(
    (task) =>
      task.emits.some((type, index) => task.emits.indexOf(type) !== index) ||
      task.consumes.some((type, index) => task.consumes.indexOf(type) !== index),
  );
  if (duplicateTask || duplicateEvent || duplicateList) {
    checks.push(
      entry("P1", "graph_shape", "fail", duplicateTask
        ? `task "${duplicateTask}" is declared twice`
        : duplicateEvent
          ? `event "${duplicateEvent}" is declared twice`
          : `task "${duplicateList!.name}" repeats an event declaration`, {
        location: duplicateTask
          ? { task: duplicateTask }
          : duplicateEvent
            ? { eventType: duplicateEvent }
            : { task: duplicateList!.name },
      }),
    );
  } else {
    checks.push(entry("P1", "graph_shape", "pass", "graph shape and identities are valid"));
  }

  let kindFailed = false;
  for (const task of artifact.graph.tasks) {
    const reason = unauthorableModeReason(task.mode);
    const message = !task.prompt?.trim()
      ? "every internal task requires an operating prompt"
      : reason
          ? `mode "${task.mode}" is not authorable: ${reason}`
          : task.mode !== "ai"
            ? `the graph compiler may author mode "ai", not "${task.mode}"`
            : null;
    if (message) {
      kindFailed = true;
      checks.push(entry("P1", "kind_constraints", "fail", message, { location: { task: task.name } }));
    }
  }
  artifact.proposedGrants.forEach((grant, index) => {
    const task = artifact.graph.tasks.find((candidate) => candidate.name === grant.taskRef);
    if (task && !REGISTRY_GRANTS[task.kind].has(grant.grantKey)) {
      kindFailed = true;
      checks.push(entry("P1", "kind_constraints", "fail", `grant ${grant.grantKey} is outside the ${task.kind} registry`, {
        location: { task: task.name, grant: index },
      }));
    }
  });
  if (!kindFailed) checks.push(entry("P1", "kind_constraints", "pass", "node kinds, schedules, modes and registries are valid"));

  const declared = new Set(eventTypes);
  let wiringFailed = false;
  for (const task of artifact.graph.tasks) {
    for (const type of task.emits) {
      if (!declared.has(type)) {
        wiringFailed = true;
        checks.push(entry("P1", "event_wiring", "fail", `emitted event "${type}" is not declared`, {
          location: { task: task.name, eventType: type },
        }));
      }
    }
  }
  const emitted = new Set(artifact.graph.tasks.flatMap((task) => task.emits));
  const consumed = new Set(artifact.graph.tasks.flatMap((task) => task.consumes));
  for (const type of emitted) {
    if (!consumed.has(type)) checks.push(entry("P1", "event_wiring", "warn", "emitted event has no in-graph consumer", { location: { eventType: type } }));
  }
  for (const type of consumed) {
    if (!emitted.has(type)) checks.push(entry("P1", "event_wiring", "warn", "consumed event has no in-graph emitter; it may be external", { location: { eventType: type } }));
  }
  if (!wiringFailed) checks.push(entry("P1", "event_wiring", "pass", "all emitted events reference declarations"));

  let ddlTables = new Map<string, DdlTable>();
  if (!artifact.store) {
    checks.push(entry("P3", "store_ddl", "pass", "the draft declares no workflow store"));
    checks.push(entry("P3", "table_specs", "pass", "no table specs are required"));
    checks.push(entry("P3", "migration_classification", "pass", "store migration class: none", { details: { migrationClass: "none", changes: [] } }));
  } else {
    const shape = checkDdlShape(artifact.store.ddl);
    if (!shape.ok) {
      checks.push(...shape.issues.map((issue) => entry("P3", "store_ddl", "fail", issue.message, {
        ...(issue.table ? { location: { table: issue.table } } : {}),
      })));
      checks.push(entry("P3", "table_specs", "fail", "table specs cannot be checked until the DDL is valid"));
      checks.push(entry("P3", "migration_classification", "fail", "migration cannot be classified until the DDL is valid"));
    } else {
      ddlTables = shape.tables;
      if (context.pool) {
        const applies = await validateDdlApplies(context.pool, artifact.store.ddl);
        checks.push(applies.ok
          ? entry("P3", "store_ddl", "pass", "store DDL is safe and applies in a rolled-back scratch schema")
          : entry("P3", "store_ddl", "fail", applies.error));
      } else {
        checks.push(entry("P3", "store_ddl", "pass", "store DDL is structurally safe (scratch apply unavailable)"));
      }
      const specIssues = checkTablesSpecBijective(shape.tables, artifact.store.tablesSpec as StoreTablesSpec);
      const ajv = new Ajv({ allErrors: true, strict: true });
      for (const [table, spec] of Object.entries(artifact.store.tablesSpec)) {
        try {
          ajv.compile(spec.schema);
        } catch (error) {
          specIssues.push({ table, message: `table schema does not compile: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
      checks.push(...(specIssues.length === 0
        ? [entry("P3", "table_specs", "pass", "table specs match DDL tables, columns and primary keys")]
        : specIssues.map((issue) => entry("P3", "table_specs", "fail", issue.message, {
            ...(issue.table ? { location: { table: issue.table } } : {}),
          }))));

      const previous = context.previousStoreDdl ? checkDdlShape(context.previousStoreDdl) : { ok: true as const, tables: new Map<string, DdlTable>() };
      if (!previous.ok) {
        checks.push(entry("P3", "migration_classification", "fail", "the current stored DDL is invalid and cannot be diffed"));
      } else {
        const diff = classifyMigration(previous.tables, shape.tables);
        checks.push(entry(
          "P3",
          "migration_classification",
          diff.class === "destructive" && !artifact.store.confirmDestructive ? "fail" : "pass",
          diff.class === "destructive" && !artifact.store.confirmDestructive
            ? "destructive store migration requires explicit confirmation"
            : `store migration class: ${diff.class}`,
          { details: { migrationClass: diff.class, changes: diff.changes } },
        ));
      }
    }
  }

  const writeTables = new Set(
    artifact.proposedGrants
      .filter((grant) => grant.grantKey === "store.write" && grant.status !== "stripped_by_baseline")
      .map((grant) => grant.grantValue),
  );
  let storeRefFailed = false;
  const needsStore = writeTables.size > 0;
  if (needsStore && !artifact.store) {
    storeRefFailed = true;
    checks.push(entry("P3", "store_references", "fail", "store.write grants require a store schema"));
  }
  for (const table of writeTables) {
    if (!ddlTables.has(table)) {
      storeRefFailed = true;
      checks.push(entry("P3", "store_references", "fail", `store.write references absent table "${table}"`, { location: { table } }));
    }
  }
  for (const table of ddlTables.keys()) {
    if (!writeTables.has(table)) checks.push(entry("P3", "store_references", "warn", `no task proposes writes to table "${table}"`, { location: { table } }));
  }
  if (!storeRefFailed) checks.push(entry("P3", "store_references", "pass", "store users and write grants reference declared tables"));

  let grantFailed = false;
  const knownTasks = new Set(taskNames);
  const secretNames = context.secretNames ? new Set(context.secretNames) : null;
  const nextGrants = artifact.proposedGrants.map((grant, index) => {
    if (!knownTasks.has(grant.taskRef)) {
      grantFailed = true;
      checks.push(entry("P4", "grant_sanity", "fail", "grant names an unknown task", { location: { grant: index } }));
    }
    if (grant.grantKey === "secret.use" && secretNames && !secretNames.has(grant.grantValue)) {
      grantFailed = true;
      checks.push(entry("P4", "grant_sanity", "fail", `secret "${grant.grantValue}" does not exist`, { location: { task: grant.taskRef, grant: index } }));
    }
    const matchingRules = (context.baselineRules ?? []).filter(
      (rule) => rule.grantKey === grant.grantKey && globMatches(rule.value, grant.grantValue),
    );
    if (matchingRules.some((rule) => rule.effect === "deny")) {
      checks.push(entry("P4", "grant_sanity", "warn", "proposal stripped because it conflicts with the account baseline", { location: { task: grant.taskRef, grant: index } }));
      return { ...grant, status: "stripped_by_baseline" as const };
    }
    if (matchingRules.some((rule) => rule.effect === "require_approval")) return { ...grant, requiresApproval: true };
    return grant;
  });
  if (context.baselineInvalid) {
    grantFailed = true;
    checks.push(entry("P4", "grant_sanity", "fail", "the account baseline contains an invalid rule"));
  }
  if (!grantFailed) checks.push(entry("P4", "grant_sanity", "pass", "grant proposals reference valid tasks and configured resources"));

  const cycles = cyclesOf(artifact.graph);
  if (cycles.length > 0 && context.maxHops === undefined) {
    checks.push(entry("P1", "cycles_budgets", "fail", "the graph contains a cycle but has no workflow loop budget", {
      details: { cycle: cycles[0] },
    }));
  } else {
    checks.push(entry("P1", "cycles_budgets", "pass", cycles.length === 0
      ? "the graph is acyclic"
      : `cycles are bounded by the workflow's ${context.maxHops} hop budget`, {
      ...(cycles[0] ? { details: { cycle: cycles[0], maxHops: context.maxHops } } : {}),
    }));
  }

  const absentTableRefs: Array<{ task: string; table: string }> = [];
  for (const task of artifact.graph.tasks) {
    for (const match of (task.prompt ?? "").matchAll(/\b(?:table|from|into)\s+["`]?([a-zA-Z_][\w]*)/gi)) {
      if (artifact.store && !ddlTables.has(match[1]!)) absentTableRefs.push({ task: task.name, table: match[1]! });
    }
  }
  checks.push(...(absentTableRefs.length === 0
    ? [entry("P2", "coherence_lints", "pass", "no mechanically detectable name drift")]
    : absentTableRefs.map(({ task, table }) => entry("P2", "coherence_lints", "warn", `prompt references absent table "${table}"`, {
        location: { task, table },
      }))));

  return { artifact: { ...artifact, proposedGrants: nextGrants }, checks };
}

export function llmGraphCompiler(transport: ChatTransport, opts: { pool?: Pool; maxAttempts?: number } = {}): GraphCompiler {
  const maxAttempts = opts.maxAttempts ?? 3;
  return {
    async compile(input) {
      const turns: Array<{ role: "user" | "assistant"; content: string }> = [
        {
          role: "user",
          content: `${GRAPH_AUTHORING_SYSTEM_PROMPT}\n\nIntent:\n${input.intent}${input.current ? `\n\nCurrent draft:\n${JSON.stringify(input.current)}` : ""}`,
        },
      ];
      let lastChecks: GraphGateEntry[] = [];
      let error = "compiler returned no artifact";
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const answer = await transport.complete(turns);
        if (answer.refused) {
          const checks = [...lastChecks, entry("P5", "self_repair", "fail", "the model provider refused the request")];
          return { ok: false, error: "graph compiler refused", report: { checks, attempts: attempt } };
        }
        try {
          const parsed = graphDraftArtifactSchema.parse(JSON.parse(unfence(answer.text ?? "")));
          const gated = await gateGraphDraft(parsed, { ...(input.gateContext ?? {}), ...(opts.pool ? { pool: opts.pool } : {}) });
          lastChecks = gated.checks;
          const failures = lastChecks.filter((check) => check.status === "fail");
          if (failures.length === 0) {
            const repair = entry("P5", "self_repair", "pass", attempt === 1 ? "the first draft passed" : `the draft passed after ${attempt - 1} repair attempt(s)`);
            return { ok: true, artifact: gated.artifact, report: { checks: [...lastChecks, repair], attempts: attempt } };
          }
          error = failures.map((failure) => `${failure.check}: ${failure.message}`).join("; ");
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
          lastChecks = [entry("P1", "graph_shape", "fail", error)];
        }
        turns.push({ role: "assistant", content: answer.text ?? "" });
        turns.push({ role: "user", content: `The deterministic gate rejected that draft:\n${error}\nReturn a corrected full JSON artifact.` });
      }
      const repair = entry("P5", "self_repair", "fail", `repair budget exhausted after ${maxAttempts} attempts`);
      return { ok: false, error, report: { checks: [...lastChecks, repair], attempts: maxAttempts } };
    },
  };
}

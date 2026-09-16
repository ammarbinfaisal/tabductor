import { describe, expect, it } from "vitest";
import { gateGraphDraft, graphDraftArtifactSchema, llmGraphCompiler } from "./graph-authoring.js";

const valid = {
  graph: {
    tasks: [
      {
        name: "watch",
        kind: "browser",
        mode: "ai",
        prompt: "Open example.com and emit page.read after extracting the title.",
        limits: {},
        emits: ["page.read"],
        consumes: [],
        schedule: {
          cron: "0 * * * *",
          tz: "UTC",
          missedPolicy: "skip",
          overlapPolicy: "skip",
          maxQueueDepth: 1,
          enabled: true,
        },
        position: null,
      },
    ],
    events: [{ type: "page.read", description: "The title read from the page.", public: false }],
  },
  store: null,
  proposedGrants: [
    { taskRef: "watch", grantKey: "navigation", grantValue: "example.com", requiresApproval: false },
  ],
};

describe("llmGraphCompiler", () => {
  it("returns a gated graph draft and inert grant proposals", async () => {
    const compiler = llmGraphCompiler({ complete: async () => ({ text: JSON.stringify(valid) }) });
    const result = await compiler.compile({ intent: "Read example.com each hour" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.graph.tasks[0]?.mode).toBe("ai");
    expect(result.artifact.proposedGrants[0]).toMatchObject({ grantKey: "navigation", grantValue: "example.com" });
    expect(result.report.checks.some((check) => check.status === "fail")).toBe(false);
  });

  it("feeds deterministic failures back and accepts a corrected full artifact", async () => {
    let calls = 0;
    const compiler = llmGraphCompiler({
      async complete(turns) {
        calls += 1;
        if (calls === 1) {
          return {
            text: JSON.stringify({
              ...valid,
              proposedGrants: [{ taskRef: "watch", grantKey: "store.write", grantValue: "seen" }],
            }),
          };
        }
        expect(turns.at(-1)?.content).toContain("outside the browser registry");
        return { text: JSON.stringify(valid) };
      },
    });
    const result = await compiler.compile({ intent: "Read example.com each hour" });
    expect(result.ok).toBe(true);
    expect(result.report.attempts).toBe(2);
  });

  it("does not retry a provider refusal", async () => {
    const compiler = llmGraphCompiler({ complete: async () => ({ refused: true }) });
    await expect(compiler.compile({ intent: "Do a thing" })).resolves.toMatchObject({
      ok: false,
      error: "graph compiler refused",
      report: { attempts: 1 },
    });
  });

  it("surfaces the unresolved gate report when the repair budget is exhausted", async () => {
    const compiler = llmGraphCompiler(
      {
        complete: async () => ({
          text: JSON.stringify({
            ...valid,
            proposedGrants: [{ taskRef: "watch", grantKey: "store.write", grantValue: "seen" }],
          }),
        }),
      },
      { maxAttempts: 2 },
    );
    const result = await compiler.compile({ intent: "Read a page" });
    expect(result).toMatchObject({ ok: false, report: { attempts: 2 } });
    expect(result.report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ check: "self_repair", status: "fail" }),
    ]));
  });
});

describe("gateGraphDraft", () => {
  const parsed = () => graphDraftArtifactSchema.parse(valid);
  const check = async (
    change: (draft: ReturnType<typeof parsed>) => void,
    expected: string,
    status: "fail" | "warn" = "fail",
    context: Parameters<typeof gateGraphDraft>[1] = {},
  ) => {
    const draft = parsed();
    change(draft);
    const result = await gateGraphDraft(draft, context);
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ check: expected, status })]));
  };

  it("reports each whole-graph check by its stable name", async () => {
    await check((draft) => draft.graph.tasks.push({ ...draft.graph.tasks[0]!, name: "watch" }), "graph_shape");
    await check((draft) => {
      draft.graph.tasks[0] = { ...draft.graph.tasks[0]!, kind: "decision", mode: "stub" };
    }, "kind_constraints");
    await check((draft) => draft.graph.tasks[0]!.emits.push("undeclared"), "event_wiring");
    await check((draft) => {
      draft.store = { description: "", ddl: "DROP TABLE x", tablesSpec: {}, confirmDestructive: false, forceDestructive: false };
    }, "store_ddl");
    await check((draft) => {
      draft.store = {
        description: "",
        ddl: "CREATE TABLE seen (id text primary key)",
        tablesSpec: { seen: { primaryKey: ["id"], schema: { type: "object", properties: {} } } },
        confirmDestructive: false,
        forceDestructive: false,
      };
    }, "table_specs");
    await check((draft) => {
      draft.proposedGrants.push({
        taskRef: "watch",
        grantKey: "store.write",
        grantValue: "seen",
        requiresApproval: false,
        status: "pending",
      });
    }, "store_references");
    await check((draft) => {
      draft.store = validStore("CREATE TABLE replacement (id text primary key)", "replacement");
    }, "migration_classification", "fail", {
      previousStoreDdl: "CREATE TABLE old_table (id text primary key)",
    });
    await check((draft) => {
      draft.proposedGrants.push({
        taskRef: "watch",
        grantKey: "secret.use",
        grantValue: "missing",
        requiresApproval: false,
        status: "pending",
      });
    }, "grant_sanity", "fail", { secretNames: [] });
    await check((draft) => {
      draft.graph.tasks.push({
        ...draft.graph.tasks[0]!,
        name: "again",
        consumes: ["page.read"],
        emits: ["page.again"],
        schedule: null,
      });
      draft.graph.tasks[0]!.consumes = ["page.again"];
      draft.graph.events.push({ type: "page.again", description: "A second page event.", public: false });
    }, "cycles_budgets");
    await check((draft) => {
      draft.store = validStore("CREATE TABLE seen (id text primary key)", "seen");
      draft.graph.tasks[0]!.prompt = "Read from missing_table";
    }, "coherence_lints", "warn");
  });

  it("strips baseline-denied proposals and raises baseline approval requirements", async () => {
    const draft = parsed();
    draft.proposedGrants.push({
      taskRef: "watch",
      grantKey: "action",
      grantValue: "click",
      requiresApproval: false,
      status: "pending",
    });
    const result = await gateGraphDraft(draft, {
      baselineRules: [
        { effect: "deny", grantKey: "navigation", value: "example.com" },
        { effect: "require_approval", grantKey: "action", value: "click" },
      ],
    });
    expect(result.artifact.proposedGrants).toEqual([
      expect.objectContaining({ grantKey: "navigation", status: "stripped_by_baseline" }),
      expect.objectContaining({ grantKey: "action", requiresApproval: true }),
    ]);
  });
});

function validStore(ddl: string, table: string) {
  return {
    description: "",
    ddl,
    tablesSpec: {
      [table]: {
        primaryKey: ["id"],
        schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      },
    },
    confirmDestructive: false,
    forceDestructive: false,
  };
}

import { afterAll, beforeAll, expect, it } from "vitest";
import { workflows } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import {
  createWorkflow,
  publishVersion,
  staticSchemaGenerator,
  type Graph,
  type SchemaGenerator,
} from "@tabductor/engine";
import { AppError } from "@tabductor/core";
import { eq } from "drizzle-orm";

/**
 * The publish-time schema compiler's contract (graph-compilation-llm.md §4 P3/P5,
 * minimal v1): generation is gated, reported per event, atomic with respect to failure —
 * and above all *stable*: a publish that changes nothing an event depends on carries its
 * schema forward without a generator call. That stability is what makes the LLM affordable
 * and the schemas trustworthy across versions, so it is asserted on call counts, not vibes.
 */

let handle: MigratedTestDb;

beforeAll(async () => {
  handle = await createMigratedTestDb();
});

afterAll(async () => {
  await handle?.close();
});

/** Counts every generate() by event type, delegating to a deterministic inner generator. */
function counting(schemas: Record<string, Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const inner = staticSchemaGenerator(schemas);
  const generator: SchemaGenerator = {
    generate: (input) => {
      calls.push(input.eventType);
      return inner.generate(input);
    },
  };
  return { generator, calls };
}

const graphOf = (opts: { promptA?: string; descB?: string } = {}): Graph => ({
  tasks: [
    {
      name: "A",
      kind: "browser",
      mode: "stub",
      prompt: opts.promptA ?? "find things",
      limits: {},
      emits: ["a.done", "b.done"],
      consumes: [],
      schedule: null,
      code: null,
      runtime: null,
      position: null,
    },
    {
      name: "B",
      kind: "browser",
      mode: "stub",
      prompt: "rank things",
      limits: {},
      emits: [],
      consumes: ["a.done"],
      schedule: null,
      code: null,
      runtime: null,
      position: null,
    },
  ],
  events: [
    { type: "a.done", description: "A finished a thing.", public: false },
    { type: "b.done", description: opts.descB ?? "B-shaped output.", public: false },
  ],
});

it("generates on first publish, reuses on an unchanged one, and regenerates exactly what changed", async () => {
  const db = handle.db;
  const workflowId = await createWorkflow(db, { name: "compile", userId: "user_test" });

  // First publish: everything is new, everything is generated.
  const first = counting();
  const v1 = await publishVersion(db, { workflowId, graph: graphOf() }, { schemaGenerator: first.generator });
  expect(v1.report.events).toEqual([
    { type: "a.done", status: "generated" },
    { type: "b.done", status: "generated" },
  ]);
  expect(first.calls.sort()).toEqual(["a.done", "b.done"]);

  // Same document again: zero calls — the steady state of a publish that tweaks nothing.
  const second = counting();
  const v2 = await publishVersion(db, { workflowId, graph: graphOf() }, { schemaGenerator: second.generator });
  expect(second.calls).toEqual([]);
  expect(v2.report.events.map((e) => e.status)).toEqual(["reused", "reused"]);

  // One event's description changes: only that event recompiles.
  const third = counting();
  await publishVersion(
    db,
    { workflowId, graph: graphOf({ descB: "B-shaped output, now with provenance." }) },
    { schemaGenerator: third.generator },
  );
  expect(third.calls).toEqual(["b.done"]);

  // An emitter's prompt is generator *context*, so its events recompile too — both of
  // them, because A emits both.
  const fourth = counting();
  await publishVersion(
    db,
    { workflowId, graph: graphOf({ descB: "B-shaped output, now with provenance.", promptA: "find MORE things" }) },
    { schemaGenerator: fourth.generator },
  );
  expect(fourth.calls.sort()).toEqual(["a.done", "b.done"]);
});

it("fails the whole publish on a failed event, reporting every event and writing nothing", async () => {
  const db = handle.db;
  const workflowId = await createWorkflow(db, { name: "compile-fail", userId: "user_test" });
  const ok = counting();
  const { versionId } = await publishVersion(db, { workflowId, graph: graphOf() }, { schemaGenerator: ok.generator });

  const halfBroken: SchemaGenerator = {
    generate: (input) =>
      Promise.resolve(
        input.eventType === "b.done"
          ? { ok: false, error: "no thanks" }
          : { ok: true, schema: { type: "object" } },
      ),
  };

  const err = await publishVersion(
    db,
    { workflowId, graph: graphOf({ promptA: "changed", descB: "changed" }) },
    { schemaGenerator: halfBroken },
  ).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(AppError);
  const report = (err as AppError).details?.report as { events: Array<{ type: string; status: string }> };
  expect(report.events).toEqual([
    { type: "a.done", status: "generated" },
    { type: "b.done", status: "failed", error: "no thanks" },
  ]);

  // Atomic: the failed compile moved nothing — same current version as before.
  const [wf] = await db.select().from(workflows).where(eq(workflows.id, workflowId));
  expect(wf!.currentVersionId).toBe(versionId);
});

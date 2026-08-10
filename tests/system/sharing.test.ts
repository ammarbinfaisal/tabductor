import { afterEach, expect, it } from "vitest";
import {
  publicEventGet,
  publicEventList,
  publicEventTypes,
  publicGraph,
  publicRunGet,
  publicRunList,
  hashToken,
  PUBLIC_PAGE_MAX,
  refCodec,
  seedWorkflow,
  triggerTask,
  type RefCodec,
} from "@tabductor/engine";
import { workflowShares } from "@tabductor/db";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createCaller } from "../../apps/web/src/server/router.js";
import { eventsOfType, startRig, waitForQuiet, type Rig } from "./engine-support.js";

/**
 * Shared workflows (S2d, `docs/sharing.md`).
 *
 * Most of these assert on the **read models**, not on a router response. That is the point:
 * the safety property is "a private packet is never selected", and a test that only checked
 * the HTTP shape would pass just as happily against a fetch-then-redact implementation that
 * had the packet in hand the whole time.
 */

let rig: Rig;

afterEach(async () => {
  await rig?.stop();
});

const SECRET_PACKET = { dm: "alice@example.com asked about the merger" };
const PUBLIC_PACKET = { url: "https://x.com/status/1", text: "hello" };

/**
 * Watcher emits a shared event; Scorer emits a private one. Both are declared, so the
 * difference between them is one flag rather than one being undeclared.
 */
async function seedShared(): Promise<{
  wf: Awaited<ReturnType<typeof seedWorkflow>>;
  api: ReturnType<typeof createCaller>;
  token: string;
  shareId: string;
  ref: RefCodec;
}> {
  rig = await startRig();
  const db = rig.handle.db;
  const wf = await seedWorkflow(db, {
    tasks: {
      Watcher: {
        stub: { emits: [{ type: "tweet.detected", packet: PUBLIC_PACKET }] },
        publicEvents: ["tweet.detected"],
        prompt: "read the timeline and do not say this out loud",
      },
      Scorer: { stub: { emits: [{ type: "score.private", packet: SECRET_PACKET }] } },
      Sink: {},
    },
    edges: [
      ["Watcher", "tweet.detected", "Scorer"],
      ["Scorer", "score.private", "Sink"],
    ],
  });

  await triggerTask(db, { taskId: wf.taskIds.Watcher! });
  await waitForQuiet(rig);

  const api = createCaller({ db });
  const { share } = await api.share.create({ workflowId: wf.workflowId });
  const [row] = await db.select().from(workflowShares).where(eq(workflowShares.id, share.id));
  return { wf, api, token: share.token, shareId: share.id, ref: refCodec(row!) };
}

/** The error tRPC actually threw, so a test can assert on its code rather than its prose. */
async function trpcError(fn: () => Promise<unknown>): Promise<TRPCError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof TRPCError) return err;
    throw err;
  }
  throw new Error("expected the procedure to reject");
}

it("never selects the packet of an event type outside the manifest", async () => {
  const { wf, ref } = await seedShared();
  const db = rig.handle.db;
  const publicTypes = await publicEventTypes(db, wf.workflowId);
  expect([...publicTypes]).toEqual(["tweet.detected"]);

  const page = await publicEventList(db, { workflowId: wf.workflowId, ref, publicTypes });
  const shared = page.items.find((e) => e.type === "tweet.detected");
  const withheld = page.items.find((e) => e.type === "score.private");

  // The shared one carries its packet.
  expect(shared?.packetPublic).toBe(true);
  expect(shared?.packet).toEqual(PUBLIC_PACKET);

  // The withheld one is *present* — hiding the event would misrepresent the timeline — but
  // the key does not exist on the object, because the column was never selected.
  expect(withheld).toBeDefined();
  expect(withheld?.packetPublic).toBe(false);
  expect(withheld && "packet" in withheld).toBe(false);

  // The strongest form of the assertion: the secret is nowhere in the serialized result.
  expect(JSON.stringify(page)).not.toContain("alice@example.com");
});

it("keeps a private hop in the lineage and drops only its packet", async () => {
  const { wf, ref } = await seedShared();
  const db = rig.handle.db;
  const publicTypes = await publicEventTypes(db, wf.workflowId);
  const [scored] = await eventsOfType(rig, "score.private");

  const detail = await publicEventGet(db, {
    workflowId: wf.workflowId,
    ref,
    publicTypes,
    eventId: scored!.eventId,
  });

  // manual.start → tweet.detected → score.private: the shape is intact, so the causal
  // chain a viewer sees is the chain that happened.
  expect(detail?.lineage.map((e) => e.type)).toEqual([
    "manual.trigger",
    "tweet.detected",
    "score.private",
  ]);
  expect(detail?.lineage.map((e) => e.packetPublic)).toEqual([false, true, false]);
  expect(JSON.stringify(detail)).not.toContain("alice@example.com");
});

it("reports a bounded error class and never the error text", async () => {
  rig = await startRig();
  const db = rig.handle.db;
  const leak = "scraped https://internal.example.com/private/1 for alice@example.com";
  const wf = await seedWorkflow(db, {
    tasks: { Boom: { stub: { permanent_fail: leak } } },
  });
  await triggerTask(db, { taskId: wf.taskIds.Boom! });
  await waitForQuiet(rig);

  const api = createCaller({ db });
  const { share } = await api.share.create({ workflowId: wf.workflowId });
  const [row] = await db.select().from(workflowShares).where(eq(workflowShares.id, share.id));

  const page = await publicRunList(db, { workflowId: wf.workflowId, ref: refCodec(row!) });
  expect(page.items).toHaveLength(1);
  expect(page.items[0]?.status).toBe("failed");
  // Unrecognised messages degrade to a label rather than to their text.
  expect(page.items[0]?.errorClass).toBe("other");
  expect(JSON.stringify(page)).not.toContain("alice@example.com");
  expect(JSON.stringify(page)).not.toContain("internal.example.com");
});

it("classifies a timeout by status rather than by message", async () => {
  rig = await startRig({ watchdogIntervalMs: 25 });
  const db = rig.handle.db;
  const wf = await seedWorkflow(db, {
    tasks: { Slow: { stub: { hang_ms: 5000 }, runTimeoutMs: 100 } },
  });
  await triggerTask(db, { taskId: wf.taskIds.Slow! });
  await waitForQuiet(rig);

  const api = createCaller({ db });
  const { share } = await api.share.create({ workflowId: wf.workflowId });
  const [row] = await db.select().from(workflowShares).where(eq(workflowShares.id, share.id));

  const page = await publicRunList(db, { workflowId: wf.workflowId, ref: refCodec(row!) });
  expect(page.items[0]?.status).toBe("timed_out");
  expect(page.items[0]?.errorClass).toBe("timeout");
});

it("exposes no prompt, no limits and no raw row id", async () => {
  const { wf, api, token, ref } = await seedShared();
  const db = rig.handle.db;

  const graph = await publicGraph(db, { versionId: wf.versionId });
  const serialized = JSON.stringify(graph);
  expect(serialized).not.toContain("do not say this out loud");
  expect(serialized).not.toContain("prompt");
  expect(serialized).not.toContain("limits");
  // `mode` is public and happens to read "stub". What must not appear is the *script*, and
  // the stub carries the packet it emits — so this catches the whole of `limits_json`.
  expect(serialized).not.toContain("https://x.com/status/1");
  expect(serialized).not.toContain(wf.taskIds.Watcher!);
  // The shape itself is public, and the manifest travels with it.
  expect(graph.tasks.map((t) => t.name)).toEqual(["Scorer", "Sink", "Watcher"]);
  expect(graph.edges).toHaveLength(2);
  const watcher = graph.tasks.find((t) => t.name === "Watcher");
  expect(watcher?.emits).toEqual([
    { type: "tweet.detected", public: true, packetSchema: { type: "object" } },
  ]);
  // A private type's schema is withheld along with its packets.
  expect(graph.tasks.find((t) => t.name === "Scorer")?.emits).toEqual([
    { type: "score.private", public: false },
  ]);

  const runs = await publicRunList(db, { workflowId: wf.workflowId, ref });
  const runIds = JSON.stringify(runs);
  for (const id of Object.values(wf.taskIds)) expect(runIds).not.toContain(id);

  // And through the router, which is what a viewer actually reaches.
  const viaApi = await api.public.graph({ token });
  expect(JSON.stringify(viaApi)).not.toContain("do not say this out loud");
});

it("refuses a ref minted for a different share", async () => {
  const { wf, api, token } = await seedShared();
  const db = rig.handle.db;

  const { share: other } = await api.share.create({ workflowId: wf.workflowId });
  const [otherRow] = await db.select().from(workflowShares).where(eq(workflowShares.id, other.id));
  const [scored] = await eventsOfType(rig, "score.private");
  const foreignRef = refCodec(otherRow!).encode(scored!.eventId);

  // Same workflow, same event, different share — the ref is still not addressable here.
  const err = await trpcError(() => api.public.event({ token, ref: foreignRef }));
  expect(err.code).toBe("NOT_FOUND");

  // The same row under this share's own key resolves, so the refusal is about the key.
  const [row] = await db.select().from(workflowShares).where(eq(workflowShares.tokenSha256, hashToken(token)));
  const mine = await api.public.event({ token, ref: refCodec(row!).encode(scored!.eventId) });
  expect(mine.event.type).toBe("score.private");
});

it("answers unknown, malformed and revoked tokens identically", async () => {
  const { api, token, shareId } = await seedShared();

  const unknown = await trpcError(() => api.public.graph({ token: "not-a-real-token" }));
  const malformed = await trpcError(() => api.public.graph({ token: "%%%" }));
  expect(unknown.code).toBe("NOT_FOUND");
  expect(unknown.message).toBe(malformed.message);

  // Live until revoked, gone immediately after — resolution is uncached.
  await expect(api.public.graph({ token })).resolves.toBeDefined();
  await api.share.revoke({ shareId });
  const revoked = await trpcError(() => api.public.graph({ token }));
  expect(revoked.code).toBe("NOT_FOUND");
  expect(revoked.message).toBe(unknown.message);
});

it("rotates to a new token and refuses to resurrect a revoked share", async () => {
  const { api, token, shareId } = await seedShared();

  const rotated = await api.share.rotate({ shareId });
  expect(rotated.token).not.toBe(token);
  await expect(api.public.graph({ token: rotated.token })).resolves.toBeDefined();
  await expect(trpcError(() => api.public.graph({ token }))).resolves.toBeDefined();

  await api.share.revoke({ shareId });
  const err = await trpcError(() => api.share.rotate({ shareId }));
  expect(err.code).toBe("NOT_FOUND");
});

it("stores no plaintext token and never returns one from a read", async () => {
  const { api, token, wf } = await seedShared();
  const rows = await rig.handle.db
    .select()
    .from(workflowShares)
    .where(eq(workflowShares.workflowId, wf.workflowId));
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain(token);
  expect(rows[0]!.tokenPrefix).toBe(token.slice(0, 8));

  const listed = await api.share.list({ workflowId: wf.workflowId });
  expect(JSON.stringify(listed)).not.toContain(token);
});

it("gives a new node's events no visibility, and takes it back when the flag goes away", async () => {
  const { wf, api } = await seedShared();
  const db = rig.handle.db;

  // A later version adds a node. Nothing about publishing it can widen the share.
  await seedWorkflow(db, {
    workflowId: wf.workflowId,
    tasks: {
      Watcher: {
        stub: { emits: [{ type: "tweet.detected", packet: PUBLIC_PACKET }] },
        publicEvents: ["tweet.detected"],
      },
      Scorer: { stub: { emits: [{ type: "score.private", packet: SECRET_PACKET }] } },
      Sink: {},
      Added: { emits: ["extra.detail"] },
    },
  });
  expect([...(await publicEventTypes(db, wf.workflowId))]).toEqual(["tweet.detected"]);
  const preview = await api.share.preview({ workflowId: wf.workflowId });
  expect(preview.privateEvents.map((e) => e.type).sort()).toEqual(["extra.detail", "score.private"]);
  expect(preview.publicEvents).toEqual([
    { task: "Watcher", type: "tweet.detected", fields: [] },
  ]);

  // Republish without the flag: visibility is withdrawn from history too, because deny
  // wins and unticking a box is understood to mean "stop showing this".
  await seedWorkflow(db, {
    workflowId: wf.workflowId,
    tasks: { Watcher: { stub: { emits: [{ type: "tweet.detected", packet: PUBLIC_PACKET }] } } },
  });
  expect([...(await publicEventTypes(db, wf.workflowId))]).toEqual([]);

  const page = await publicEventList(db, {
    workflowId: wf.workflowId,
    ref: refCodec({ tokenSha256: "irrelevant" }),
    publicTypes: await publicEventTypes(db, wf.workflowId),
  });
  expect(page.items.every((e) => !e.packetPublic)).toBe(true);
  expect(JSON.stringify(page)).not.toContain("https://x.com/status/1");
});

it("clamps a hostile limit and rejects one past the router's ceiling", async () => {
  const { wf, api, token, ref } = await seedShared();

  const page = await publicRunList(rig.handle.db, { workflowId: wf.workflowId, ref, limit: 9999 });
  expect(page.items.length).toBeLessThanOrEqual(PUBLIC_PAGE_MAX);

  const err = await trpcError(() => api.public.runs({ token, limit: 9999 }));
  expect(err.code).toBe("BAD_REQUEST");
});

it("serves a run's trigger and emissions under the same manifest", async () => {
  const { wf, ref } = await seedShared();
  const db = rig.handle.db;
  const publicTypes = await publicEventTypes(db, wf.workflowId);

  const list = await publicRunList(db, { workflowId: wf.workflowId, ref });
  const scorer = list.items.find((r) => r.taskName === "Scorer");
  const detail = await publicRunGet(db, {
    workflowId: wf.workflowId,
    ref,
    publicTypes,
    runId: ref.decode(scorer!.ref)!,
  });

  // Triggered by the shared event, emitted the private one.
  expect(detail?.trigger?.type).toBe("tweet.detected");
  expect(detail?.trigger?.packet).toEqual(PUBLIC_PACKET);
  expect(detail?.emitted.map((e) => e.type)).toContain("score.private");
  expect(JSON.stringify(detail)).not.toContain("alice@example.com");
});

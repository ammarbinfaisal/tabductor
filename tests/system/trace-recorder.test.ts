import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { AppError } from "@tabductor/core";
import {
  artifactRows,
  blobFiles,
  openSession,
  payloadOf,
  startBrowserRig,
  traceRows,
  type BrowserRig,
  type SessionRig,
} from "./browser-support.js";

let rig: BrowserRig;
let sess: SessionRig | undefined;

beforeAll(async () => {
  rig = await startBrowserRig();
});

afterEach(async () => {
  await sess?.close();
  sess = undefined;
});

afterAll(async () => {
  await rig?.close();
});

it("offloads a screenshot to the blob store and resolves it back", async () => {
  sess = await openSession(rig);
  const { page } = sess.session;

  await page.goto(`${rig.fx.url}/fake-tweets`);
  const shot = await page.screenshot();
  await sess.trace.flush();

  const artifact = (await artifactRows(rig, sess.runId))[0]!;
  expect(artifact.kind).toBe("screenshots");
  expect(artifact.meta).toMatchObject({ mime: "image/png", bytes: shot.byteLength });

  // The ref round-trips to the same bytes — the property the run inspector (U1.5) renders
  // screenshots through, and the only thing that makes `blob_ref` worth storing.
  expect(await rig.blobs.get(artifact.blobRef)).toEqual(shot);

  const entry = (await traceRows(rig, sess.runId)).find(
    (r) => payloadOf(r).action === "screenshot",
  )!;
  expect(entry.blobRef).toBe(artifact.blobRef);
});

it("a task that opted out of screenshots stores no blob, and still traces the action", async () => {
  // The store is shared with the test above, so the assertion is "nothing new", not
  // "nothing at all" — a screenshot of a *different* page would still be a new file.
  const before = await blobFiles(rig);
  sess = await openSession(rig, { storage: { screenshots: false } });
  const { page } = sess.session;

  await page.goto(`${rig.fx.url}/fake-gram`);
  await page.screenshot();
  await sess.trace.flush();

  // Evaluated at write time: nothing was written and then removed, so there is no window in
  // which the bytes existed on disk or in a backup (§14).
  expect(await artifactRows(rig, sess.runId)).toEqual([]);
  expect(await blobFiles(rig)).toEqual(before);

  const entry = (await traceRows(rig, sess.runId)).find(
    (r) => payloadOf(r).action === "screenshot",
  )!;
  expect(entry.blobRef).toBeNull();
  expect(payloadOf(entry).ok).toBe(true);
});

it("a rejected blob ref never reaches the filesystem", async () => {
  const err = await rig.blobs.get("../../etc/passwd").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe("blob_ref_invalid");
});

it("close flushes what the buffer still held", async () => {
  sess = await openSession(rig);
  const { page } = sess.session;
  const { runId } = sess;

  await page.goto(`${rig.fx.url}/fake-gram`);
  expect(await traceRows(rig, runId)).toEqual([]); // buffered, not yet written

  await sess.close();
  sess = undefined;

  const rows = await traceRows(rig, runId);
  // The document request's `network` row (S3b) joins the two already here — its response
  // settles, and is written, before `goto`'s own action entry is (the entry is written after
  // `goto` resolves, by which point the response that let it resolve already landed).
  expect(rows.map((r) => r.kind)).toEqual(["navigation", "network", "action"]);
  expect(rows.map((r) => r.seq)).toEqual([0, 1, 2]);
});

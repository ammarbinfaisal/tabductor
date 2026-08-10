import { expect, it } from "vitest";
import { createPagedStore, pagedStoreFor } from "./paged-store.js";

/**
 * The list store, exercised as a plain object — which is the reason U0 put client state in
 * vanilla stores rather than in React. There are still no UI tests: nothing here renders.
 *
 * These cover the three rules that are invisible at the call site and were each, at some
 * point, wrong: a refresh re-requests every page on screen, a filter change goes back to
 * page one, and two lists of the same subject are two stores.
 */

type Row = { id: string };

/** A loader that records what it was asked for, so the assertions can be about calls. */
function recorder(pages: Record<string, { items: Row[]; nextCursor: string | null }>) {
  const calls: Array<string | null> = [];
  return {
    calls,
    load: ({ cursor }: { cursor: string | null }) => {
      calls.push(cursor);
      return Promise.resolve(pages[cursor ?? "first"] ?? { items: [], nextCursor: null });
    },
  };
}

it("re-requests every page on screen, not only the first", async () => {
  const { calls, load } = recorder({
    first: { items: [{ id: "a" }], nextCursor: "c1" },
    c1: { items: [{ id: "b" }], nextCursor: null },
  });
  const store = createPagedStore<Row, Record<string, never>>({ extra: {}, load });

  await store.refresh();
  expect(store.getState().items.map((r) => r.id)).toEqual(["a"]);

  store.more();
  await store.refresh();
  expect(store.getState().items.map((r) => r.id)).toEqual(["a", "b"]);

  // The point: page one is fetched again alongside page two. A run that finishes on a later
  // page has to update while the earlier pages keep polling.
  calls.length = 0;
  await store.refresh();
  expect(calls).toEqual([null, "c1"]);
});

it("sends a filter change back to page one", async () => {
  const { load } = recorder({
    first: { items: [{ id: "a" }], nextCursor: "c1" },
    c1: { items: [{ id: "b" }], nextCursor: null },
  });
  const store = createPagedStore<Row, { status: string }>({ extra: { status: "" }, load });

  await store.refresh();
  store.more();
  await store.refresh();
  expect(store.getState().cursors).toEqual([null, "c1"]);

  store.narrow({ status: "failed" });
  expect(store.getState().status).toBe("failed");
  expect(store.getState().cursors).toEqual([null]);
});

it("keeps a load failure out of the rows and in the error", async () => {
  const store = createPagedStore<Row, Record<string, never>>({
    extra: {},
    load: () => Promise.reject(new Error("postgres is asleep")),
  });

  await store.refresh();
  expect(store.getState().items).toEqual([]);
  expect(store.getState().error).toBe("postgres is asleep");
});

it("gives two lists of the same subject two stores", () => {
  const make = <E extends object>(extra: E) => () =>
    createPagedStore<Row, E>({ extra, load: () => Promise.resolve({ items: [], nextCursor: null }) });

  // The runs table and the event feed share a scope — a workflow id, or a share token — and
  // hold different state shapes. Keyed on the scope alone the second one reads the first
  // one's state, which surfaces as an undefined field a long way from the cause.
  const runs = pagedStoreFor("runs", "workflow:w1", make({ status: "" }));
  const events = pagedStoreFor("events", "workflow:w1", make({ type: "", types: [] }));

  expect(runs).not.toBe(events);
  expect(runs.getState()).toHaveProperty("status");
  expect(events.getState()).toHaveProperty("types");

  // Same list, same scope, same store: that is what keeps state across a re-render.
  expect(pagedStoreFor("runs", "workflow:w1", make({ status: "" }))).toBe(runs);
});

"use client";

import type { Page } from "@tabductor/engine";
import { createStore, type StoreApi } from "zustand/vanilla";
import { asApiError } from "./api.js";

/**
 * The list machinery behind the runs table and the event feed (U0.5).
 *
 * Both are the same list: cursor-paged, polled every two seconds, with a filter that sends
 * it back to page one. That combination has one non-obvious rule inside it — a refresh
 * re-requests *every page on screen*, not just the first, or a run that finishes on page
 * three would never update while page one keeps ticking — and a rule like that survives
 * being written once and copied never.
 *
 * `Extra` is whatever else a particular list owns: its filter, and anything it derives from
 * what it has loaded. It lives in the same store rather than beside it, so a component
 * subscribes once and its rows can never be a different generation from the controls above
 * them.
 */

export type PagedState<T> = {
  items: T[];
  /** The pages on screen, oldest first. `[null]` is the first page, and there is always one. */
  cursors: Array<string | null>;
  nextCursor: string | null;
  error: string | null;
};

export type PagedStore<T, Extra> = StoreApi<PagedState<T> & Extra> & {
  refresh: () => Promise<void>;
  /** Append the next page. Paging forward never drops the pages already shown. */
  more: () => void;
  /** Change the filter: back to page one, then reload. */
  narrow: (patch: Partial<Extra>) => void;
  /** Surface a failure from an action of the caller's own, where load failures already go. */
  fail: (err: unknown) => void;
};

export function createPagedStore<T, Extra extends object>(init: {
  extra: Extra;
  load: (args: Extra & { cursor: string | null }) => Promise<Page<T>>;
  /**
   * State derived from every row currently on screen. Applied by the same `setState` that
   * lands the rows, so a filter's options and its rows are always in step.
   */
  onLoaded?: (items: T[], state: PagedState<T> & Extra) => Partial<Extra>;
}): PagedStore<T, Extra> {
  const store = createStore<PagedState<T> & Extra>(() => ({
    items: [],
    cursors: [null],
    nextCursor: null,
    error: null,
    ...init.extra,
  }));

  const refresh = async (): Promise<void> => {
    const before = store.getState();
    try {
      const pages: Array<Page<T>> = [];
      for (const cursor of before.cursors) pages.push(await init.load({ ...before, cursor }));
      const items = pages.flatMap((p) => p.items);
      store.setState((state) =>
        Object.assign(
          { ...state, items, nextCursor: pages.at(-1)?.nextCursor ?? null, error: null },
          init.onLoaded?.(items, state),
        ),
      );
    } catch (err) {
      store.setState((state) => ({ ...state, error: asApiError(err).message }));
    }
  };

  return {
    ...store,
    refresh,

    more() {
      const { nextCursor, cursors } = store.getState();
      if (!nextCursor) return;
      store.setState((state) => ({ ...state, cursors: [...cursors, nextCursor] }));
      void refresh();
    },

    narrow(patch) {
      store.setState((state) => Object.assign({ ...state, items: [], cursors: [null] }, patch));
      void refresh();
    },

    fail(err) {
      store.setState((state) => ({ ...state, error: asApiError(err).message }));
    },
  };
}

/**
 * One store per list, kept across renders.
 *
 * A component cannot hold its own store without `useState`, which the hook policy rules out,
 * so the store is looked up by key. Looking a store up is idempotent, which is the point:
 * the alternative pattern, a single module store reset from the render body when the scope
 * changes, both writes state during render and makes two lists on one page fight over it.
 *
 * The identity is `(list, scope)` and `list` is its own argument rather than something the
 * caller is trusted to fold into the scope string. A workflow's runs and its events share a
 * scope, so keying on scope alone hands one component the other's store — with the other's
 * state shape, which surfaces as an undefined field a long way from the cause.
 */
const stores = new Map<string, unknown>();

/** Distinct lists visited in one session. Far above any page, small enough to never matter. */
const MAX_STORES = 8;

export function pagedStoreFor<T, Extra>(
  list: string,
  scope: string,
  make: () => PagedStore<T, Extra>,
): PagedStore<T, Extra> {
  const key = `${list}|${scope}`;
  const existing = stores.get(key);
  if (existing) return existing as PagedStore<T, Extra>;

  const created = make();
  stores.set(key, created);
  // Map iterates in insertion order, so this drops the least recently created list. Nothing
  // mounted is ever evicted: reaching the cap needs more simultaneous lists than a page has,
  // and an evicted store costs a reload, not correctness.
  if (stores.size > MAX_STORES) stores.delete(stores.keys().next().value!);
  return created;
}

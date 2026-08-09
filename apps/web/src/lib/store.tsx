"use client";

import { useSyncExternalStore } from "react";
import type { StoreApi } from "zustand/vanilla";
import { useMountHook } from "./use-mount-hook.js";

/**
 * The sanctioned client-state pattern (U0). Every interactive page owns one vanilla store:
 * a plain object plus action functions that call the vanilla tRPC client. No React Query,
 * no useState — client state is inspectable without opening React devtools, and a store is
 * testable as a plain object if it ever needs to be.
 *
 * **The one hook-policy exemption, and it lives here.** `useStoreBridge` subscribes a
 * component to a store and re-renders it on change. The U0 brief allows a `forceUpdate`
 * tick counter for this; `useSyncExternalStore` is the same idea with React's own API —
 * one hook, no counter, and no tearing under concurrent rendering. It is confined to this
 * file, and the ESLint config exempts this path by name. Nothing else may reach for a hook.
 */
export type Store<T> = StoreApi<T>;

export function useStoreBridge<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/**
 * The liveness pattern for runs and events: poll on an interval, clear on unmount. No
 * websockets in U0 — the outbox already gives the engine its own latency budget, and a
 * second one on the read side would be a second thing to debug.
 */
export function usePolling(fn: () => void, intervalMs: number): void {
  useMountHook(() => {
    fn();
    const timer = setInterval(fn, intervalMs);
    return () => clearInterval(timer);
  });
}

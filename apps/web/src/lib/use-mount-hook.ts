"use client";

import { useEffect } from "react";

/**
 * The only React hook this codebase calls (`docs/subphases/ROADMAP.md`). It runs `fn` once
 * after mount and honours the cleanup it returns — subscriptions, intervals, that shape.
 *
 * Every other hook is banned by lint. The point is that component-local state stops being
 * an option, which pushes client state into the vanilla stores in `store.tsx` and data
 * fetching into server components or the vanilla tRPC client, where both are inspectable
 * without a React devtools session.
 *
 * This file is the one place `useEffect` may be imported, and the lint config exempts it
 * by path.
 */
export function useMountHook(fn: () => void | (() => void)): void {
  // Empty deps is the entire point: this hook is "on mount", not "when things change".
  useEffect(fn, []);
}

import type { RunSession } from "@tabductor/browser";
import type { CtxHost, EmitFn, EmitOutcome, StateStore } from "@tabductor/static-rt";

/**
 * A `CtxHost` with no browser behind it, for the tests that are about the *cage* rather than
 * about what it is wired to. Every method throws if reached, so a test that accidentally
 * depends on a page fails loudly instead of passing for the wrong reason.
 */
export function unusedSession(): RunSession {
  const nope = (what: string) => (): never => {
    throw new Error(`this test should not have reached ${what}`);
  };
  return {
    page: new Proxy({} as RunSession["page"], {
      get: (_t, prop) => nope(`page.${String(prop)}`),
    }),
    network: new Proxy({} as RunSession["network"], {
      get: (_t, prop) => nope(`network.${String(prop)}`),
    }),
    openTab: nope("openTab"),
    resolveAnchor: () => undefined,
    dialogSeen: () => false,
    close: async () => {},
  };
}

export function memoryState(initial: Record<string, unknown> = {}): StateStore & { all: () => Record<string, unknown> } {
  const store = { ...initial };
  return {
    get: async (key) => store[key],
    set: async (key, value) => {
      store[key] = value;
    },
    all: () => ({ ...store }),
  };
}

export function recordingEmit(): EmitFn & { calls: { type: string; packet: unknown; dedupeKey?: string }[] } {
  const calls: { type: string; packet: unknown; dedupeKey?: string }[] = [];
  const fn = (async (type, packet, opts): Promise<EmitOutcome> => {
    calls.push({ type, packet, ...(opts?.dedupeKey === undefined ? {} : { dedupeKey: opts.dedupeKey }) });
    return { ok: true, eventId: `evt_${calls.length}` };
  }) as EmitFn & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

export function hostWith(overrides: Partial<CtxHost> = {}): CtxHost {
  return {
    session: unusedSession(),
    emit: recordingEmit(),
    state: memoryState(),
    ...overrides,
  };
}

/** Wraps an expression as a §11-shaped default-exported run function. */
export function script(body: string): string {
  return `export default async function run(ctx) {\n${body}\n}`;
}

import { defineConfig } from "vitest/config";

/**
 * The live-eval suite (S4b spec §6, last bullet): same fixtures as `tests/system/`, run in
 * `live` mode against a real provider, asserting *outcomes* only — never exact action
 * sequences, because a live model's path through the tool registry is not reproducible the
 * way a replay transcript's is. Deliberately a **separate config**, not a project inside
 * `vitest.config.ts`: `pnpm test`/`pnpm test:system` never load this file, so there is no
 * project name to remember to exclude and no way for `vitest run` (bare) to pick these tests
 * up by accident. Run explicitly: `pnpm test:live-eval` (nightly/manual only, per
 * impl-phases's cross-phase testing doctrine — "no CI test touches ... a live LLM").
 *
 * Every test in here guards on `providerFromEnv(process.env)` and skips itself when neither
 * key is set — this file's exclusion from the default projects is the belt, the guard is the
 * suspenders.
 */
export default defineConfig({
  test: {
    name: "live-eval",
    environment: "node",
    include: ["tests/live-eval/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});

import parser from "@typescript-eslint/parser";

/**
 * Workspace lint. Today it enforces one rule, and it is a §17.2 rule rather than a style
 * preference: **no `console`**. A log line that did not go through the injected `Logger` has
 * no level, no `run_id`/`task_id`/`trace_id` bindings, and never reaches Loki — so it is
 * invisible exactly when someone is trying to work out what happened.
 *
 * `apps/web` has its own config (the React hook policy) and is linted separately.
 */
export default [
  {
    files: ["packages/**/*.ts", "apps/engine/**/*.ts", "apps/renderer/**/*.ts", "apps/pyrunner/**/*.ts"],
    ignores: [
      "**/*.test.ts",
      // The testkit is developer-facing tooling whose output IS the console, and core's
      // console logger is the fallback sink the rule exists to funnel everything into.
      "apps/testkit/**",
      "packages/core/src/logger.ts",
      // A CLI whose whole output is one line to a terminal.
      "packages/db/src/migrate.ts",
    ],
    languageOptions: {
      parser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
    rules: {
      "no-console": "error",
    },
  },
];

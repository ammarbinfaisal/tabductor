import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "system",
          environment: "node",
          include: ["tests/system/**/*.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});

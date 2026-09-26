import { afterEach, expect, it, vi } from "vitest";
import { isDevMode } from "./dev-mode.js";

afterEach(() => vi.unstubAllEnvs());

it.each([
  [undefined, undefined, true],
  ["development", undefined, true],
  ["production", undefined, false],
  ["test", undefined, false],
  ["production", "1", true],
  ["development", "0", false],
] as const)("resolves dev mode for NODE_ENV=%s and override=%s", (nodeEnv, override, expected) => {
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.stubEnv("TABDUCTOR_DEV_MODE", override);
  expect(isDevMode()).toBe(expected);
});

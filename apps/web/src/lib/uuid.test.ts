import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "./uuid.js";

afterEach(() => vi.unstubAllGlobals());

it("uses the native UUID generator when available", () => {
  const id = "00112233-4455-4677-8899-aabbccddeeff";
  vi.stubGlobal("crypto", { randomUUID: () => id });
  expect(randomUUID()).toBe(id);
});

it.each([0, 255])("generates a v4 UUID without randomUUID (random byte %i)", (byte) => {
  vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => bytes.fill(byte) });
  expect(randomUUID()).toBe(byte === 0
    ? "00000000-0000-4000-8000-000000000000"
    : "ffffffff-ffff-4fff-bfff-ffffffffffff");
});

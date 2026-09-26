import { afterEach, expect, it, vi } from "vitest";
import { asApiError } from "./api.js";

const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
afterEach(() => {
  if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
  else Reflect.deleteProperty(globalThis, "navigator");
  vi.unstubAllGlobals();
});

it("shows an offline message instead of an empty-response JSON parser error", () => {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: false } });
  expect(asApiError(new SyntaxError("Failed to execute 'json' on 'Response': Unexpected end of JSON input")))
    .toEqual({ message: "No internet connection. Check your connection and try again.", details: {} });
});

import { describe, expect, it } from "vitest";
import { monthlyPeriod, overageMicros } from "./subscriptions.js";

describe("monthly subscription allowances", () => {
  it("clamps short months without losing the signup anniversary", () => {
    const anchor = new Date("2024-01-31T12:00:00Z");
    expect(monthlyPeriod(anchor, new Date("2024-02-29T12:00:00Z"))).toEqual({ start: new Date("2024-02-29T12:00:00Z"), end: new Date("2024-03-31T12:00:00Z") });
    expect(monthlyPeriod(anchor, new Date("2024-02-29T11:59:59Z")).start).toEqual(anchor);
  });
  it("charges elapsed browser time and decimal GB, consuming inclusion first", () => {
    expect(overageMicros(72000000,72000000,120000,3600000)).toBe(0);
    expect(overageMicros(72030000,72000000,120000,3600000)).toBe(1000);
    expect(overageMicros(2500000000,2000000000,12000000,1000000000)).toBe(6000000);
    expect(overageMicros(400000000,200000000,null,1000000000)).toBe(0);
  });
});

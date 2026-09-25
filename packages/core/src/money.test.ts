import { expect, it } from "vitest";
import { usdMicros, usdDecimal, scaledAmount } from "./money.js";
it("represents decimal USD exactly, including sub-cent balances",()=>{
  expect(usdMicros("0.10")*3).toBe(usdMicros("0.30"));
  expect(usdDecimal(usdMicros("0.50")-usdMicros("0.10"))).toBe("0.40");
  expect(usdDecimal(usdMicros("0.000001"))).toBe("0.000001");
  expect(usdDecimal(-100000)).toBe("-0.10");
  expect(scaledAmount(13,200000,1000000)).toBe(3);
});
it("rejects ambiguous, negative, nonfinite, overprecise or overflowing input",()=>{
  for(const value of ["-1","NaN","Infinity","1e3","0.0000001","9007199254.740992","","1,000",".1"])
    expect(()=>usdMicros(value),value).toThrow();
});

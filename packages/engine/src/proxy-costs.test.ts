import { expect,it } from "vitest";
import { parseProxyReport } from "./proxy-costs.js";
it("reads exact byte quantities and quoted CSV",()=>{
  expect(parseProxyReport('Date,Traffic (B)\r\n"2026-09-24","123456789"\r\n')).toEqual([{day:"2026-09-24",bytes:123456789}]);
  expect(parseProxyReport("Date;Bytes\n2026-09-25;0")).toEqual([{day:"2026-09-25",bytes:0}]);
  expect(parseProxyReport("Date,Traffic (B)\n")).toEqual([]);
});
it("does not silently interpret unknown units or corrupt reports as zero usage",()=>{
  for(const csv of ["Date,Traffic (GB)\n2026-09-25,1.2","Date,Bytes\n2026-09-25,-1","Date,Bytes\n2026-09-25,NaN"])
    expect(()=>parseProxyReport(csv)).toThrow();
});

it("aggregates the provider's per-host report without double-counting its footer",()=>{
  expect(parseProxyReport("date,hostname,port,data,measurement unit,requests count\n2026-09-24,example.com,443,2000000000,B,3\n2026-09-24,cdn.example.com,443,500000000,B,2\n,,total:,2500000000,,5\n")).toEqual([{day:"2026-09-24",bytes:2500000000}]);
  expect(()=>parseProxyReport("date,hostname,port,data,measurement unit,requests count\n2026-09-24,example.com,443,2,GB,3")).toThrow("bytes");
});

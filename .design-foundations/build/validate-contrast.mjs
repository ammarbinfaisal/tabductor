#!/usr/bin/env node
// Supplementary WCAG validator for DESIGN.md's committed pairs — the ones
// palette.mjs's built-in report does not cover (entity chips, stamps, banners,
// control borders, focus ring, map markers). Reads the LOCKED token block out
// of DESIGN.md itself and exits 1 on any FAIL.
//
//   node .design-foundations/build/validate-contrast.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const md = readFileSync(join(root, "DESIGN.md"), "utf8");
const tokens = {};
for (const m of md.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6}|var\(--([\w-]+)\));/g))
  tokens[m[1]] = m[3] ?? m[2];
const resolve = (n) => {
  if (!tokens[n]) throw new Error(`token --${n} not found in DESIGN.md`);
  return tokens[n].startsWith("#") ? tokens[n] : resolve(tokens[n]);
};

const lum = (hexs) => {
  const v = [1, 3, 5].map((i) => parseInt(hexs.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(resolve(a)), lum(resolve(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// [label, fg, bg, target] — target 0 = report-only probe, not gated.
const pairs = [
  ["text on background", "text", "background", 4.5],
  ["text-secondary on background", "text-secondary", "background", 4.5],
  ["text on surface", "text", "surface", 4.5],
  ["event-text on event-bg (chip)", "event-text", "event-bg", 4.5],
  ["event-text on background", "event-text", "background", 4.5],
  ["event-text on surface", "event-text", "surface", 4.5],
  ["event-on-solid on event-solid (CTA)", "event-on-solid", "event-solid", 4.5],
  ["node-text on node-bg (chip)", "node-text", "node-bg", 4.5],
  ["node-text on background", "node-text", "background", 4.5],
  ["node-text on surface", "node-text", "surface", 4.5],
  ["node-on-solid on node-solid", "node-on-solid", "node-solid", 4.5],
  ["banner-error-text on banner-error-bg", "banner-error-text", "banner-error-bg", 4.5],
  ["status-failed stamp on background", "status-failed", "background", 4.5],
  ["compile-generated stamp on background", "compile-generated", "background", 4.5],
  ["compile-reused stamp on background", "compile-reused", "background", 4.5],
  ["success-11 on success-3", "success-11", "success-3", 4.5],
  ["banner-warning-text on banner-warning-bg", "banner-warning-text", "banner-warning-bg", 4.5],
  ["status-timed-out stamp on background", "status-timed-out", "background", 4.5],
  ["status-running stamp on background", "status-running", "background", 4.5],
  ["info-11 on info-3", "info-11", "info-3", 4.5],
  ["visibility-public-text on visibility-public-bg", "visibility-public-text", "visibility-public-bg", 4.5],
  ["visibility-private-text on background", "visibility-private-text", "background", 4.5],
  ["control-border on background (non-text 1.4.11)", "border-control", "background", 3.0],
  ["focus-ring on background (non-text)", "focus-ring", "background", 3.0],
  ["map event marker border on background", "event-border", "background", 3.0],
  ["map node marker border on background", "node-border", "background", 3.0],
  ["map-edge on background (non-text)", "map-edge", "background", 3.0],
  // probes — documented as fills-only in DESIGN.md, not gated:
  ["probe: border-strong on background", "border-strong", "background", 0],
  ["probe: event-solid on background", "event-solid", "background", 0],
  ["probe: node-solid on background", "node-solid", "background", 0],
];

let fails = 0;
for (const [label, fg, bg, target] of pairs) {
  const r = ratio(fg, bg);
  const gated = target > 0;
  const ok = !gated || r >= target;
  if (!ok) fails++;
  console.log(`${gated ? (ok ? "PASS" : "FAIL") : "INFO"}  ${label}: ${r.toFixed(2)}:1${gated ? ` (target ${target}:1)` : ""}`);
}
if (fails) { console.error(`\n${fails} committed pair(s) below target`); process.exit(1); }
console.log("\nAll committed pairs pass.");

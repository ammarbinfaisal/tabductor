#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The S5b leak-lint gate (§16 Threat 4). "There is no `get(name): string` anywhere, ever" is
 * the primary control the secrets broker relies on, and a control that only lives in a comment
 * drifts the first time someone is in a hurry. This script fails `pnpm lint` the same way an
 * ESLint rule would if any declaration in the tree has the shape of a value-returning secret
 * accessor.
 *
 * Crude regex, deliberately (`S5b-secrets-broker.md`: "crude is fine; loud is the point") — a
 * false positive costs someone a one-line exemption in `EXEMPT_FILES` with a reason; a missed
 * real one costs a plaintext secret in a diff.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(HERE, "..", "..", "..");

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "migrations", "coverage"]);

// Decryption legitimately happens only inside these two files (§16: "decryption happens only
// inside the secret broker"). Nowhere else in the tree gets an exemption.
const EXEMPT_FILES = new Set(["packages/secrets/src/crypto.ts", "packages/secrets/src/broker.ts"]);

const PATTERNS = [
  { name: "get*Secret*: string", re: /get.*[Ss]ecret.*:\s*(Promise<)?string/ },
  { name: "decrypt*: string", re: /decrypt.*:\s*(Promise<)?string/ },
];

function collectTsFiles(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectTsFiles(full, out);
    else if (extname(entry.name) === ".ts") out.push(full);
  }
}

const files = [];
collectTsFiles(ROOT, files);

const hits = [];
for (const file of files) {
  const rel = relative(ROOT, file);
  if (EXEMPT_FILES.has(rel)) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const { name, re } of PATTERNS) {
      if (re.test(line)) hits.push(`${rel}:${i + 1}: matches "${name}" — ${line.trim()}`);
    }
  });
}

if (hits.length > 0) {
  console.error("leak-lint: found what looks like a value-returning secret accessor (§16 Threat 4):\n");
  for (const hit of hits) console.error(`  ${hit}`);
  console.error(
    '\nThere must be no `get(name): string`-shaped export anywhere. Fix it, or if this is a\n' +
      "genuine false positive, add the file to EXEMPT_FILES in packages/secrets/scripts/leak-lint.mjs\n" +
      "with a comment saying why.",
  );
  process.exit(1);
}

console.log(`leak-lint: scanned ${files.length} .ts files, no value-returning secret accessor found.`);

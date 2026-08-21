import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE = path.join(repoRoot, "apps/testkit/fixtures/loader/secrets-roundtrip.ts");

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tabductor-kek-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Vitest cannot catch this class of bug, which is exactly why the test spawns a process.
 *
 * `sodium-native` is CJS whose members the native binding attaches at load time, so
 * `cjs-module-lexer` cannot see them statically and Node synthesizes a namespace missing most
 * of them. Under `node --import tsx` — how `apps/engine` runs — `import * as sodium` left
 * `crypto_aead_xchacha20poly1305_ietf_KEYBYTES` undefined, so `KEY_BYTES` was undefined at
 * module load and `randomDek()` threw `invalid size`. The entire secrets subsystem was dead in
 * the deployed engine while this suite stayed green, because vitest's transform produces
 * different interop and papers over the difference.
 *
 * So: assert the crypto path works under the runtime that actually ships it, not under the one
 * that runs the tests.
 */
it("seals and unseals a DEK under `node --import tsx`, the loader the engine runs", async () => {
  const { stdout } = await run(
    process.execPath,
    ["--import", "tsx", FIXTURE, path.join(dir, "kek.json")],
    { cwd: repoRoot },
  );
  expect(stdout.trim()).toBe("ok");
}, 60_000);

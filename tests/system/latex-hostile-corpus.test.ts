import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInSandbox, type SandboxConfig, type SandboxKillReason } from "../../apps/renderer/src/sandbox.js";
import { ensureSandboxImage, readFixture, SANDBOX_IMAGE } from "./latex-support.js";

/**
 * The hostile corpus (S5e deliverable 6, `impl-phases.md`'s "LaTeX fixtures" bullet): every
 * case here runs against the *real* `apps/renderer/sandbox` Docker image — `ensureSandboxImage`
 * builds it from `apps/renderer/sandbox/Dockerfile` if it is not already cached, and every
 * `runInSandbox` call below is a genuine `docker run` with `--network none`/`--read-only`, not
 * a bare local `tectonic` invocation. This machine has Docker as a baseline requirement
 * already (Postgres and MinIO run as containers), so — unlike S5h's `/dev/kvm` gate — there is
 * no expected environment where this suite would need to skip.
 *
 * Table-driven, extend on every new idea (same posture as S6's `isolated-vm` corpus and S5h's
 * Firecracker corpus). Each case names, in its own assertion, whether the control that fired
 * is **structural** (nothing to kill — the sandbox image simply has no `/etc/passwd`, no
 * shell, no writable path outside scratch) or **runtime** (the wall clock or the memory cap
 * actually intervened) — the two are different failure classes worth distinguishing
 * operationally, per the spec.
 *
 * Two different resource envelopes, deliberately: a generous one for the structural cases (and
 * the wall-clock loop, whose fixture must not accidentally lose the race to the memory cap —
 * empirically, tectonic's own bookkeeping grows *some* memory per macro expansion even for a
 * loop that neither typesets nor accumulates a value, so "generous memory, short wall clock"
 * is what actually isolates the wall-clock control) and a tight one for the memory-bomb case
 * (whose fixture doubles a string exponentially, so it wins the race against a *generous*
 * wall clock even at a small cap).
 */

let scratchRoot = "";

const BASE: Omit<SandboxConfig, "scratchRoot"> = {
  image: SANDBOX_IMAGE,
  wallClockMs: 15_000,
  memoryBytes: 512 * 1024 * 1024,
  pidsLimit: 32,
};

function configFor(overrides: Partial<Omit<SandboxConfig, "scratchRoot">>): SandboxConfig {
  return { ...BASE, ...overrides, scratchRoot };
}

beforeAll(async () => {
  await ensureSandboxImage();
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  scratchRoot = mkdtempSync(join(tmpdir(), "tabductor-hostile-scratch-"));
}, 300_000);

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  if (scratchRoot) await rm(scratchRoot, { recursive: true, force: true });
});

describe("structural controls — nothing to kill, because there is nothing to reach", () => {
  it("\\write18 is ignored — shell escape is structurally absent, not merely refused", async () => {
    const outcome = await runInSandbox(configFor({}), {
      texSource: readFixture("hostile-write18.tex").toString("utf8"),
      files: [],
    });
    // Tectonic disables runsystem() unconditionally under --untrusted (belt-and-suspenders
    // with TECTONIC_UNTRUSTED_MODE baked into the image) — the document still compiles,
    // just without ever having run the command. This is not a "killed" outcome: nothing
    // needed killing because there was never a subprocess to spawn in the first place.
    expect(outcome.ok).toBe(true);
  });

  it("\\input{/etc/passwd} fails closed — the sandbox image has no /etc/passwd at all", async () => {
    const outcome = await runInSandbox(configFor({}), {
      texSource: readFixture("hostile-input-passwd.tex").toString("utf8"),
      files: [],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("compile_error");
    expect(outcome.log).toMatch(/not found/i);
  });

  it("a write outside the scratch dir is blocked by the read-only container filesystem", async () => {
    const outcome = await runInSandbox(configFor({}), {
      texSource: readFixture("hostile-write-outside-scratch.tex").toString("utf8"),
      files: [],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // Read-only FS, not a resource-cap breach — `compile_error`, never `killed`.
    expect(outcome.kind).toBe("compile_error");
    expect(outcome.log).toMatch(/read-only/i);
  });

  it("an image path naming a host location directly is blocked the same way", async () => {
    const outcome = await runInSandbox(configFor({}), {
      texSource: readFixture("with-image-host-path.tex").toString("utf8"),
      files: [],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("compile_error");
    expect(outcome.log).toMatch(/not found/i);
  });
});

describe("runtime controls — the sandbox actively intervenes and kills the render", () => {
  it(
    "an infinite macro-expansion loop is stopped by the wall clock",
    async () => {
      const outcome = await runInSandbox(configFor({ wallClockMs: 3_000 }), {
        texSource: readFixture("hostile-loop.tex").toString("utf8"),
        files: [],
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.kind).toBe("killed");
      expect((outcome as { reason: SandboxKillReason }).reason).toBe("wall_clock");
    },
    30_000,
  );

  it(
    "a memory-bomb document is stopped by the memory cap",
    async () => {
      const outcome = await runInSandbox(configFor({ memoryBytes: 128 * 1024 * 1024 }), {
        texSource: readFixture("hostile-memory-bomb.tex").toString("utf8"),
        files: [],
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.kind).toBe("killed");
      expect((outcome as { reason: SandboxKillReason }).reason).toBe("memory");
    },
    30_000,
  );
});

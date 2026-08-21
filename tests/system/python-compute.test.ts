import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postRun, pythonIsAvailable, startPyrunnerRig, type PyRig } from "./python-support.js";

/**
 * The pyrunner's own contract: a directory in, a directory out, a wall clock over the top.
 *
 * **The hostile corpus is gone, and its absence is deliberate — not an oversight.** The
 * original S5h spec asked for network attempts, `subprocess`, fork bombs and memory bombs, all
 * asserted to be *blocked*. That corpus tested a Firecracker microVM. tabductor is now
 * self-hosted open source: a `mode=python` program is the operator's own code, there is no
 * untrusted tenant, and the container is the isolation unit. Under this design those programs
 * succeed. Asserting they are blocked would be writing tests that fail; asserting they succeed
 * would be testing CPython. Neither is worth a line.
 *
 * What is left is everything that is still a real contract between this process and its
 * caller: the wall clock actually kills, caps are outcomes rather than truncations, a symlink
 * is not followed, and a determinism guarantee the executor's byte-stability rests on.
 */

let rig: PyRig;
let hasPython = false;

beforeAll(async () => {
  hasPython = await pythonIsAvailable();
  if (hasPython) rig = await startPyrunnerRig();
}, 60_000);

afterAll(async () => {
  await rig?.stop();
});

const itPy = (name: string, fn: () => Promise<void>, timeout?: number): void => {
  it(name, async () => {
    if (!hasPython) {
      // Loud, not silent: a skipped suite must say why rather than look like a pass.
      console.warn(`SKIPPED (no python3 on PATH): ${name}`);
      return;
    }
    await fn();
  }, timeout);
};

itPy("runs a program and returns its outputs", async () => {
  const res = await postRun(rig, {
    code: [
      "import json, pathlib",
      "trigger = json.loads(pathlib.Path('in/trigger.json').read_text())",
      "pathlib.Path('out/files/answer.txt').write_text(str(trigger['n'] * 2))",
      "print('hello from python')",
    ].join("\n"),
    trigger: { n: 21 },
  });
  expect(res.ok).toBe(true);
  const files = res.files as { path: string; contentBase64: string }[];
  expect(files).toHaveLength(1);
  expect(files[0]!.path).toBe("answer.txt");
  expect(Buffer.from(files[0]!.contentBase64, "base64").toString()).toBe("42");
  expect(res.stdout).toContain("hello from python");
});

itPy("declared assets arrive in in/assets, and nested output paths keep their shape", async () => {
  const res = await postRun(rig, {
    code: [
      "import pathlib",
      "src = pathlib.Path('in/assets/seed.txt').read_text()",
      "out = pathlib.Path('out/files/reports/nested')",
      "out.mkdir(parents=True)",
      "(out / 'copy.txt').write_text(src.upper())",
    ].join("\n"),
    assets: [{ filename: "seed.txt", contentBase64: Buffer.from("hi there").toString("base64") }],
  });
  expect(res.ok).toBe(true);
  const files = res.files as { path: string; contentBase64: string }[];
  expect(files[0]!.path).toBe("reports/nested/copy.txt");
  expect(Buffer.from(files[0]!.contentBase64, "base64").toString()).toBe("HI THERE");
});

itPy("a non-zero exit is a program_error carrying the traceback", async () => {
  const res = await postRun(rig, { code: "raise ValueError('deliberate')" });
  expect(res.ok).toBe(false);
  expect(res.kind).toBe("program_error");
  expect(res.exitCode).toBe(1);
  expect(res.stderr).toContain("deliberate");
});

itPy("the wall clock kills a program that will not stop", async () => {
  const res = await postRun(rig, { code: "while True:\n    pass", wallClockMs: 1_000 });
  expect(res.ok).toBe(false);
  expect(res.kind).toBe("killed");
  expect(res.reason).toBe("wall_clock");
}, 30_000);

/**
 * The regression test for `detached: true` + `process.kill(-pid)`. A forked grandchild holds
 * the stdout pipe open; kill only the direct child and `close` never fires, so the request
 * hangs until the test times out rather than returning a `killed` outcome.
 */
itPy("the wall-clock kill reaches the whole process group, not just the child", async () => {
  const res = await postRun(rig, {
    code: ["import os, time", "os.fork()", "while True:", "    time.sleep(0.05)"].join("\n"),
    wallClockMs: 1_000,
  });
  expect(res.ok).toBe(false);
  expect(res.kind).toBe("killed");
}, 30_000);

itPy("a symlink in out/files is counted, never followed", async () => {
  const res = await postRun(rig, {
    code: [
      "import os, pathlib",
      "pathlib.Path('out/files/real.txt').write_text('genuine')",
      "os.symlink('/etc/passwd', 'out/files/link')",
    ].join("\n"),
  });
  expect(res.ok).toBe(true);
  const files = res.files as { path: string }[];
  expect(files.map((f) => f.path)).toEqual(["real.txt"]);
  expect(res.skipped).toEqual({ nonRegular: 1 });
});

describe("output caps are outcomes, not truncations", () => {
  itPy("too many files", async () => {
    const res = await postRun(rig, {
      code: ["import pathlib", "for i in range(50):", "    pathlib.Path(f'out/files/f{i}.txt').write_text('x')"].join("\n"),
    });
    expect(res).toMatchObject({ ok: false, kind: "output_cap", limit: "file_count" });
  });

  itPy("a single file over the per-file cap", async () => {
    const res = await postRun(rig, {
      code: "open('out/files/big.bin','wb').write(b'x' * (600 * 1024))",
    });
    expect(res).toMatchObject({ ok: false, kind: "output_cap", limit: "file_bytes" });
  });

  itPy("too many emit lines", async () => {
    const res = await postRun(rig, {
      code: [
        "import json",
        "with open('out/emits.jsonl','w') as f:",
        "    for i in range(100):",
        "        f.write(json.dumps({'type':'a.b','packet':{'i':i}}) + '\\n')",
      ].join("\n"),
    });
    expect(res).toMatchObject({ ok: false, kind: "output_cap", limit: "emit_lines" });
  });

  /**
   * One enormous line, and the assertion that matters is the *timing*: the size gate reads
   * `lstat` before opening the file, so a 100 MB line is refused without ever allocating a
   * buffer for it. A streaming reader that checked line length after reading would still be
   * correct and still pass the shape assertion — but it would allocate 100 MB first.
   */
  itPy("one oversized emit line is refused without reading it", async () => {
    const started = Date.now();
    const res = await postRun(rig, {
      code: "open('out/emits.jsonl','w').write('{\"type\":\"a.b\",\"packet\":\"' + 'x' * (100 * 1024 * 1024) + '\"}')",
    });
    expect(res).toMatchObject({ ok: false, kind: "output_cap", limit: "emit_bytes" });
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 40_000);
});

itPy("stdout is capped and says so rather than growing without bound", async () => {
  const res = await postRun(rig, { code: "print('y' * 200_000)" });
  expect(res.ok).toBe(true);
  expect((res.stdout as string).length).toBeLessThanOrEqual(8 * 1024);
  expect(res.truncated).toMatchObject({ stdout: true });
});

/**
 * The reason `job.ts` spawns `-s -B` and not `-I`. `-I` implies `-E`, which ignores every
 * `PYTHON*` variable — so `-I` together with `PYTHONHASHSEED=0` cancels itself, hash
 * randomization stays on, and set iteration order changes between runs. Every byte-stability
 * guarantee downstream (the `.xlsx` fixture, a recompiled deliverable) rests on this.
 */
itPy("set iteration order is stable across runs, so output can be byte-stable", async () => {
  const code = [
    "s = {'alpha','beta','gamma','delta','epsilon','zeta','eta','theta'}",
    "open('out/files/order.txt','w').write(','.join(s))",
  ].join("\n");
  const [a, b] = await Promise.all([postRun(rig, { code }), postRun(rig, { code })]);
  expect(a.ok && b.ok).toBe(true);
  const read = (r: typeof a): string =>
    Buffer.from((r.files as { contentBase64: string }[])[0]!.contentBase64, "base64").toString();
  expect(read(a)).toBe(read(b));
});

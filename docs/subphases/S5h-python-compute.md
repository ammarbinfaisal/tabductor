# S5h — Python compute mode (`kind=asset`, `mode=python`)

You are implementing subphase S5h. Read, in order:
1. This file (authoritative).
2. `docs/python-compute.md` — the whole document. It is the design; this file is the build order.
3. `docs/impl-phases.md` — the S5h section under Phase 5.
4. `docs/techical_plan.md` — §4 (the `(kind, mode)` registry rule), §5 (mode constraints),
   §12 (the same principle in a different sandbox), §13.5–§13.6, §16 Threats 8 and 18–22, §17.2.
5. `docs/subphases/ROADMAP.md` — the node-kinds block and the `(kind, mode)` registry rule.
6. `docs/subphases/S5a-kind-asset-executor.md` — your prerequisite, and the registry this
   subphase re-keys. S5d (asset store) is your other prerequisite; read its section in
   `docs/impl-phases.md` and §13.5 of the design doc, plus whatever it shipped as code.

Existing code to reuse (read first): `packages/engine/src/executor.ts` (the `TaskExecutor`
contract and `RunHandle.emit` — you publish through it, you do not reimplement it),
`stub-executor.ts` (the shape of a minimal executor), `packet-schema.ts` (ajv validation you
must route emits through), `graph.ts` (`publishVersion` document→rows projection),
`packages/db`, `apps/engine/src/main.ts` (how a composition root is wired),
`packages/telemetry/src/init.ts` (composition roots only). S5e's renderer is the sibling
design; MCP, secrets and the workflow store are **not yours**.

## Scope

An asset node that runs an authored Python program on our infrastructure and produces files
— `.xlsx` above all. Prerequisites are **S5a** (the `kind`/`mode` discriminants and the
executor registry re-key) and **S5d** (asset store + `BlobStore`, without which outputs have
nowhere to land). Independent of S5b/S5c/S5e. Not in scope: authoring the code with an LLM
(S8), store reads as Parquet inputs (S5g), any UI (U3).

## Deliverables

1. **`(kind, mode)` tool registry.** S5a re-keyed the *executor* registry; re-key the *tool*
   registry to match. `(asset, ai)` keeps `mcp.*`/`assets.*`/`emit` unchanged;
   **`(asset, python)` gets no tool registry at all.** Add the test that asserts this
   alongside S5c's registry-isolation test: building the tool schema for a `mode=python`
   task must yield nothing, not a filtered list.

2. **Constraint extension (`packages/db`, additive).** Extend S5a's named
   `tasks_kind_mode_check` to `mode IN ('ai','compiled','python')` and
   `NOT (kind <> 'asset' AND mode = 'python')`, keeping the existing asset/compiled clause.
   Drop-and-re-add in one migration; the constraint is named so this is a two-line ALTER.
   Rejected at save time by the control plane, re-asserted by the check.

3. **Graph document (`packages/engine/src/graph.ts`).**
   - `GraphTask.code = { language: "python", source: string }` and
     `GraphTask.runtime = { image, packages: string[], inputs: { assets: [], tables: [] } }`.
     Reserve `tables` in the schema and reject a non-empty value — it lands with S5g.
   - Projected into `tasks.code_source`, `tasks.code_sha256`, `tasks.runtime_json`.
   - `checkGraph` validates `packages ⊆ manifest[image]` against a manifest file committed
     to the repo, and rejects `mode=python` without `code`.
   - Code changes go through `publishVersion`. **Do not add code to `updateTask`** — runs
     pin their version, `code_sha256` feeds the task content hash, and an in-place code edit
     would make "which program produced this spreadsheet" unanswerable.

4. **`apps/pyrunner`** — a composition root (it calls `initTelemetry`, like `apps/engine`),
   HTTP, on an **internal** compose network reachable only by `engine`. Two backends behind
   one interface:
   - **`firecracker`** — the default whenever `/dev/kvm` is present, and the only backend
     that is a security boundary.
   - **`subprocess`** — rlimits and an unshared netns where the host allows it. Labelled
     not-a-boundary in the interface docstring, in `infra/README.md`, and in a startup log
     line. Refuses to start without `PYRUNNER_ALLOW_UNSAFE_BACKEND=1`.

5. **The sandbox** (`python-compute.md` §5 is the specification; build exactly it).
   - Every job: a fresh microVM under **`jailer`** — do not reimplement the chroot, cgroup,
     uid/gid drop or netns pinning.
   - **No network device in the machine config.** Not a filtered one. None.
   - `--no-api` with a static config file, so there is no live API socket. No vsock.
   - Read-only rootfs (the pinned image); one freshly created ext4 scratch drive as the
     **only** I/O channel; 1 vCPU; memory, CPU and wall-clock caps; concurrent-job cap.
   - **Build the scratch image with `mke2fs -d` and read it back with `debugfs -R rdump`.**
     Both userspace. Never loop-mount an image written by untrusted code — doing so puts the
     host kernel's ext4 parser on the attack surface and trades the boundary away at the
     last step.
   - Guest init is ~30 lines: mount, `python -I /job/code/main.py`, tee size-capped
     stdout/stderr, write `_status.json`, power off. Serial console to a size-capped host
     file for kernel diagnostics only.
   - Vendor `firecracker`, `jailer` and a minimal uncompressed `vmlinux` into the image,
     pinned by hash. They are not installed on any dev machine here.

6. **The job protocol** (`python-compute.md` §3.1) — `/job/in/trigger.json`,
   `/job/in/assets/<name>`, `/job/code/main.py`, `/job/out/{files,emits.jsonl,_status.json,
   stdout,stderr}`, `/job/tmp`. Inputs are **declared in the graph document** and resolved by
   the host before boot; there is no runtime path by which the program asks for anything.

7. **Extraction is a trust boundary** (§5.4). After `rdump`: only regular files; every path
   normalised and re-validated against §16 Threat 8's rules *and* the task's
   `asset_write_grants` glob; file count, per-file size and total size capped, with a breach
   being a sandbox kill rather than a truncation; `emits.jsonl` size- and line-capped and
   parsed line by line.

8. **`PythonExecutor` (`packages/engine`)**, registered for `(asset, python)`: resolve
   declared inputs → call the runner → extract → write asset versions → **publish emits
   host-side through `RunHandle.emit`**, so packet-schema validation, dedupe, loop budget and
   the transactional outbox apply unchanged and cannot be bypassed. Emits publish only after
   a successful exit. A program error surfaces `stderr` and retries per policy; a **sandbox
   kill fails the run permanently** — a job that hit the wall clock will hit it again.

9. **Determinism** (§6): `PYTHONHASHSEED=0`, `PYTHONDONTWRITEBYTECODE=1`,
   `PYTHONNOUSERSITE=1`, `python -I`, `TZ=UTC`, `SOURCE_DATE_EPOCH` from the trigger
   timestamp, `MPLBACKEND=Agg`, `MPLCONFIGDIR=/job/tmp/mpl`.

10. **Telemetry:** `pyrun_jobs_total{outcome}`, `pyrun_duration_seconds{outcome}`,
    `pyrun_vm_boot_seconds`, `pyrun_sandbox_kills_total{reason}`, `pyrun_output_bytes` — those
    exact names (§17.2 is binding). Kills go on the security-signals dashboard beside the
    renderer row. No source, no output contents, no file names in any signal.

11. **System tests** (`tests/system/`, content-named):
    - **Hostile corpus, table-driven, extended whenever someone thinks of a new escape:**
      network attempts of every flavour (`socket`, `urllib`, `requests`, raw fd);
      `subprocess` / `os.system`; fork bomb against the pid limit; memory bomb; infinite loop
      against the wall clock; a write outside `/job/out`; a symlink pointing out of scratch;
      output over the byte cap and over the file-count cap; `../../etc/passwd` as an output
      filename; a 100 MB single-line `emits.jsonl`.
    - Contract: emits validated host-side against the declared packet schema; a malformed
      emit fails the run; a sandbox kill fails permanently with no retry row; a package
      outside the manifest is rejected at publish; `kind=browser, mode=python` is rejected
      at publish **and** by the check constraint on a direct insert.
    - Happy path: a fixture program producing a byte-stable `.xlsx` after timestamp
      normalisation (normalise `docProps/core.xml` and zip entry mtimes before comparing —
      the same rule as the PDF fixtures; do not chase byte-identity by accident).
    - E2E: browser (or stub) node emits pricing rows → python node writes
      `/reports/pricing-<date>.xlsx` with a pivot and a chart → emits `report.ready
      {asset_ref}` → a downstream node reads bytes matching the asset's `sha256`.
    - The entire Phase 2 and Phase 5 suites re-run green.

    **Sandbox-suite gating:** the hostile corpus runs on the `firecracker` backend only and
    **skips with a visible message** when `/dev/kvm` is absent. Never silently, and never by
    re-pointing at the subprocess backend — that would turn the sandbox suite into a suite
    that tests nothing.

## Style constraints (binding)

- The registry stays a map keyed on `(kind, mode)`. No executor class hierarchy.
- No host callable, no network device, no vsock, no shared directory between host and guest.
  If you find yourself wanting one, stop: §16 Threat 22 says that reopens the exfiltration
  chain and needs a design-doc change, not a workaround.
- The dependency manifest is a committed file, not a table and not an env var.
- Python in this repo is guest-side only. `main.py` fixtures and the ~30-line guest init are
  the entire Python surface; nothing in `packages/` or `apps/` gains a Python build step.
- `no-console` applies to `apps/pyrunner` like every other app.

## Verification

```
pnpm install && pnpm build && pnpm test && pnpm lint
```

All prior tests stay green; run twice. Then, with `/dev/kvm` available:
`docker compose up -d` and confirm `pyrunner` starts on the internal network, reports the
`firecracker` backend, and that the engine can reach it while the runner can reach nothing.
Run the E2E and open the produced `.xlsx`. Confirm the sandbox suite runs (not skips) here,
and confirm it *does* skip loudly with `/dev/kvm` masked.

## Report back

What you built, deviations + why, commands + outcomes, flakiness noticed. State plainly
which backend the sandbox suite ran on and whether any hostile-corpus case was skipped.
List every channel that exists between guest and host — the expected answer is one block
device. Do NOT git commit.

---

## As built (S5h, migration `0015_python_compute`)

This spec was written against the microVM design. The project became open-source and
self-hosted before it was implemented, which removed the threat model the isolation half was
built for — see the 0.2 changelog at the top of `docs/python-compute.md` for the full list of
what that withdrew. What actually shipped:

**`apps/pyrunner`** — an ordinary compose service on an internal `compute` network, no
published ports, no docker socket, no route off the host. A job is written to a temp directory
and run as a subprocess (`python -s -B code/main.py`) with `cwd` at the job root; the container
is the isolation unit and a wall-clock kill is the only runtime control. Files: `main.ts`
(composition root, app-local zod env), `server.ts` (`POST /run`, `GET /status` for the compose
healthcheck, concurrency semaphore), `job.ts` (directory, subprocess, collection).

**`PythonExecutor`** (`packages/engine/src/python-executor.ts`, exported via the
`@tabductor/engine/python` subpath so `minimatch` stays out of `apps/web`'s import of the
engine barrel) — registered for `(asset, python)`, withheld with a log line when `PYRUNNER_URL`
is unset, the same posture the AI executors take without a key. It resolves declared inputs,
calls pyrunner, then does every privileged act host-side: validating **all** output paths
before writing **any** of them, writing through `putVersion` (so grants, content addressing and
version rows are the ones `assets.write` already uses), and publishing emits through
`RunHandle.emit` so the compiled packet schema, the `task_emits` gate, the loop budget, dedupe
and the outbox all still apply.

**`{"$asset": "<relative output path>"}`** — a substitution neither this spec nor the design doc
named, and the canonical flow needs it: the program writes `emits.jsonl` before any `asset_id`
exists, and has no channel to ask for one. It names an output by the path it wrote; the executor
swaps in the real ref. An unresolvable placeholder fails the run rather than publishing an event
that points at nothing.

**Outcome mapping** — `program_error` retryable (a correctable defect), `killed` /
`output_cap` / path rejection permanent (a wall-clock breach reproduces).

### Deviations from this document, and why

| Spec said | Shipped | Why |
|---|---|---|
| Firecracker microVM, jailer, vendored kernel, `/dev/kvm` gate, dual backend | A plain subprocess inside the pyrunner container | No untrusted tenant once the project is self-hosted open source |
| Hostile corpus asserting network/`subprocess`/fork-bomb/memory-bomb are blocked | Corpus withdrawn; wall clock, caps, symlinks and determinism kept | Those programs now succeed by design — the tests would be asserting a falsehood |
| `mode IN ('ai','compiled','python')` in the check constraint | Two exclusions; `mode` stays open | `mode` is `z.string()` so test-only executors can claim values; `scripted-browser.test.ts` publishes `mode='scripted'` in five places and a closed domain breaks the whole S3b suite |
| `python -I` with `PYTHONHASHSEED=0` | `python -s -B` with an explicit env | `-I` implies `-E`, which ignores `PYTHONHASHSEED` — the pair cancels itself and makes byte-stability flaky. Verified empirically |
| Absolute `/job/...` paths | `cwd`-relative, plus `TABDUCTOR_JOB_DIR` | No per-job chroot, so a literal `/job` would force single concurrency |
| `pyrun_sandbox_kills_total`, `pyrun_vm_boot_seconds` | `pyrun_kills_total`; boot metric dropped | No sandbox to name, no VM to boot. §17.2 names are binding, so the rename is recorded rather than made silently |

### Tests

`python-compute.test.ts` (runner contract: wall clock incl. the process-group case, caps,
symlink, determinism), `python-executor.test.ts` (host boundary, fake client — traversal,
grants, duplicates, `$asset`, malformed emits, permanent-vs-retryable),
`kind-constraints.test.ts` (publish gate + DB constraint, including the `mode='scripted'`
regression guard), `python-manifest.test.ts` (manifest ↔ `requirements.txt`),
`python-xlsx.test.ts` (byte-stable workbook; skips loudly without `xlsxwriter`),
`python-e2e.test.ts` (stub → python → asset → downstream, real Python process),
`python-registry-isolation.test.ts` (the empty registry).

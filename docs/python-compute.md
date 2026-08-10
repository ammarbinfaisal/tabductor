# Python Compute — `mode=python` on the Asset Node

**Version:** 0.1 (extends `techical_plan.md` 0.5)
**Status:** Specifies a third execution mode for asset nodes: a Python program, authored by an LLM or a human, run on our infrastructure inside a Firecracker microVM with a fixed dependency set, consuming a trigger packet and declared inputs and producing files, notably `.xlsx`. Covers the job contract, the dependency manifest, the sandbox, determinism, and Threats 18–22.

Decisions incorporated from review: Python is a **mode on `kind=asset`**, not a fourth kind; isolation is a **Firecracker microVM per job**, not a subprocess and not a shared container.

---

## 1. Purpose and Scope

The platform can browse, decide, call MCP tools and render documents. It cannot compute. Anything numeric — a pivot, a regression, a variance table, a valuation, a chart — currently has to be produced by an LLM writing prose about numbers, which is the one thing an LLM is worst at and the one thing a 30-line Python program is best at.

`mode=python` closes that gap. The canonical example, alongside §1's tweets-to-Instagram:

> A browser node scrapes competitor pricing nightly. A decision node picks the SKUs that moved. A **python node** loads the history, computes week-over-week deltas and a rolling median, writes `/reports/pricing-<date>.xlsx` with a pivot sheet and a chart, and emits `report.ready {asset_ref}`. A browser node uploads it to the team's shared drive.

**In scope.** Deterministic batch computation over data the platform already has: the trigger packet, assets the task declares as inputs, and (once S5g lands) tables from the workflow store. Outputs are files and emitted events.

**Out of scope.** Interactive notebooks. Long-running or streaming jobs. GPU work. Network access of any kind — not restricted, *absent* (§5.2). Arbitrary `pip install` (§4). Python as a general escape hatch for things the tool registries deliberately withhold: there is no Python route to a page, an MCP server, or a secret.

## 2. Placement in the Kind/Mode Model

### 2.1 Why a mode on `asset`, and why that is safe

`tasks` carries two orthogonal discriminants (§4): `kind` selects the tool registry, `mode` selects how execution happens. Python is a *how*, so it is a mode. It sits on `kind=asset` because its work is the asset node's work — consume events, produce files, emit refs — with no page and no browser anywhere near it.

The obvious objection is the one `docs/subphases/ROADMAP.md` raises: the registries are disjoint **as a security control**, and `kind=asset` is the kind that holds `mcp.*`, the egress tools. Arbitrary code plus network egress in one node is the exfiltration chain §4 exists to sever.

It is severed here, more completely than a registry rule could:

**S5a re-keys the executor registry on `(kind, mode)`. Make the *tool* registry a function of `(kind, mode)` too.**

| `(kind, mode)` | Tool registry |
|---|---|
| `(browser, ai)` / `(browser, compiled)` | `page.*`, `network.*`, `secrets.fill`, `emit` |
| `(asset, ai)` | `mcp.*`, `assets.*`, `store.query/insert/upsert`, `emit` |
| `(asset, python)` | **none** |
| `(decision, ai)` | `store.query`, `emit` |

A Python job has no tool surface at all. There is no host bridge, no callable, no RPC channel — the program's entire universe is a block device and a process exit code (§3, §5.3). It cannot call MCP because it cannot call anything. The chain is severed by the absence of a channel rather than by a rule about which names appear in a list, which is the stronger of the two and the kind §2 principle 2 asks for.

This also answers the question that follows immediately: why not give the Python job `assets.*` so it can read and write directly? Because that would require the bridge. Inputs are resolved by the host *before* boot and outputs are collected by the host *after* exit — the same discipline §13.5 already applies to the LaTeX renderer, where images are resolved into the scratch dir by the host and the `.tex` never names a host path.

### 2.2 Mode taxonomy update

`mode` becomes `ai | compiled | python`, with these constraints — the first two already exist as of S5a, the rest are new:

- `kind=asset` may not be `mode=compiled` (§18 decision 10, unchanged in substance; reworded to "never compiled **by the §11 script compiler**", since a Python program is authored, not compiled from traces, and carries no guards or deopt).
- `kind=browser` may not be `mode=python`.
- `kind=decision` may not be `mode=python` — a decision node's registry is deliberately the smallest in the system and this would make it the largest.
- Therefore `mode=python` implies `kind=asset`, and S5a's named `tasks_kind_mode_check` is extended rather than replaced.

Python tasks are event-triggered only, inheriting the asset node's rule (§18 decision 9). They are exempt from the promotion/demotion counters, like every asset task.

## 3. The Execution Contract

### 3.1 The job bundle

The host prepares one filesystem; the guest reads and writes only that.

```
/job/code/main.py           the task's source, from the pinned graph version
/job/in/trigger.json        the trigger event's packet
/job/in/assets/<name>       declared input assets, resolved by the host (S5d)
/job/in/tables/<name>.parquet   declared store tables, materialised by the host (S5g)
/job/out/files/*            outputs — become asset versions
/job/out/emits.jsonl        one {"type": ..., "packet": {...}} per line
/job/out/_status.json       written by the guest init: exit code, wall time
/job/out/stdout, /job/out/stderr    size-capped
/job/tmp/                   scratch: MPLCONFIGDIR, temp files
```

Inputs are **declared in the graph document**, not discovered at runtime. A task states which asset paths and which store tables it needs; the host resolves them before boot. Declared inputs are what make the job auditable, what let the publish gate check that the paths and tables exist, and what keep the sandbox channel-free — a program that could ask for a file at runtime would need a channel to ask through.

The `tables` input materialises the read fence of `graph-compilation-llm.md` §3.5 into a file: the declared SELECT runs host-side under the workflow's reader role, in a `READ ONLY` transaction with the pinned `search_path`, and the rows land as Parquet. The Python program gets a dataframe, not a database connection. That part lands with S5g; without it, `tables` is simply unavailable.

### 3.2 Emits are published host-side

The guest writes `emits.jsonl`. The **host** reads it after the VM exits and calls the same `handle.emit()` the `StubExecutor` uses, one line at a time. Packet-schema validation (ajv, against the task's declared `event_defs`), loop budget, dedupe and the transactional outbox therefore apply unchanged and cannot be bypassed.

This is §12's "every `ctx` call crosses the boundary into the host, where the policy check happens", expressed in a sandbox that has no calls. A malformed line fails the run with the ajv error, exactly as a malformed agent emit does.

Emits are published **after** a successful exit. A job that is killed mid-write emits nothing, which is the correct semantics for at-least-once: the run failed, the retry policy applies, and the trigger event's dedupe claim is already held by attempt 0 (`packages/engine/src/retry.ts`).

### 3.3 Outputs become assets

Every regular file under `/job/out/files/` becomes an asset version at the task's declared output prefix, subject to the task's `asset_write_grants` glob (§13.5) and re-validated against §16 Threat 8's path rules on the host side after extraction (§5.4). Non-regular entries are not extracted at all. File count and total bytes are capped from the task's limits, under a configured ceiling.

### 3.4 Failure and retry

A non-zero exit surfaces `stderr` — in practice a Python traceback — to the run as a typed error, and where the task is driven by an LLM authoring loop, back to the model as a tool error it may correct within budget. This mirrors S5e's rule for the TeX log, and for the same reason: LLM-authored code fails on shape mismatches routinely, and a one-shot failure would make the feature unusable.

Sandbox kills (wall clock, memory, output cap) are distinct from program failures: they fail the run **permanently**, without retry, and increment `pyrun_sandbox_kills_total{reason}`. A job that hit the wall clock will hit it again.

### 3.5 Where the source lives

In the graph document — `GraphTask.code = { language: "python", source }` — projected by `publishVersion` into `tasks.code_source` and `tasks.code_sha256`.

Code changes go through `publishVersion`, **not** `updateTask`. `updateTask` exists for the knobs you turn while watching a graph run (prompt, mode, limits) and deliberately does not version. Code is structural history: you want to know which version of the program produced which xlsx, runs already pin their version, and `code_sha256` feeds the task content hash that `graph-compilation-llm.md` §6.3 keys compiled artifacts on.

## 4. Dependencies: a Pinned Image, Not a Package Manager

One versioned image, `pyrunner-base:<tag>`, carrying a fixed and pinned dependency set. The initial manifest:

`numpy` · `pandas` · `pyarrow` · `openpyxl` · `XlsxWriter` · `scipy` · `statsmodels` · `matplotlib` · `python-dateutil` · `orjson`

A task declares `runtime: { image: "py-2026.08", packages: ["pandas", "openpyxl"] }`. The declared `packages` must be a **subset of the manifest for that image**, checked at publish against a manifest file committed to the repo. There is no `pip install` at run time, and there could not be one — the VM has no network.

Adding a package is a new image tag, a manifest entry and a doc change. This is the same rule the tool registries follow, for the same reason: the set of things a sandboxed author can reach should change by review, not by drive-by.

**Be clear about what the allowlist is for.** It is provenance and legibility — a reader of the graph can see what a node depends on, and a future policy grant has something to bind to. It is *not* the security boundary. The boundary is the microVM. A malicious package in the image would be a supply-chain problem (Threat 21) and not an escape, because there is nowhere for it to escape to.

## 5. Isolation: Firecracker

### 5.1 Why a microVM

Three candidates, and the trade is worth stating plainly because the chosen one is the most machinery.

**A subprocess with rlimits** is not a security boundary against hostile code. It shares the host kernel with everything, `unshare` of a network namespace needs `CAP_NET_ADMIN` we would rather not hold, and every kernel LPE is a full compromise of the runner. `techical_plan.md` §12 already refuses Node's `vm` module on exactly this reasoning; the same standard applies here.

**A container per job** is better and is what §13.5 specifies for the LaTeX renderer. But something must create it, and inside our own containerised deployment that means handing the engine or the runner the docker socket — which is root-equivalent on the host, a far worse blast radius than the thing it is protecting against.

**A Firecracker microVM per job** gives a separate kernel, a hardware virtualisation boundary, and — the property that decides it — the ability to configure a VM with **no network device at all**. Not a blocked network, not a filtered one: no NIC exists in the machine. Boot is ~125 ms with a minimal kernel, which is well inside the latency budget of a batch node. The cost is `/dev/kvm` and two vendored binaries.

### 5.2 VM configuration

Every job boots a fresh VM under **`jailer`** — the supported wrapper that does the chroot, the cgroup, the uid/gid drop and the netns pinning. Do not reimplement it.

- **No network interface.** The machine config declares none. Belt and braces, the jailer pins the process into an empty network namespace.
- **`--no-api`, static `--config-file`.** The VM is fully described before it starts, so there is no live API socket for anything to talk to.
- **Read-only rootfs** — the pinned `pyrunner-base` image as `vda`, mounted `ro`.
- **One read-write scratch drive** — `vdb`, a freshly created ext4 image holding the whole `/job` tree from §3.1. This is the only writable surface and the only I/O channel (§5.3).
- **1 vCPU**, memory cap from the task's limits under a configured ceiling, jailer cgroup v2 CPU and memory limits on the host side, a host wall-clock `SIGKILL` on the `firecracker` process, and a cap on concurrent jobs.
- **No vsock.** Adding one would create a live guest→host channel to secure; the scratch drive already carries everything.
- Serial console captured to a size-capped host file for kernel and init diagnostics only. The program's own output goes to the scratch drive so it survives the VM and is traced under the user's storage opt-outs.
- Kernel: a minimal uncompressed `vmlinux`, no modules, pinned and hash-checked into the image alongside `firecracker` and `jailer`.

Guest init is deliberately about thirty lines: mount `vdb` at `/job`, run `python -I /job/code/main.py` with the environment from §6, tee stdout and stderr to size-capped files, write `_status.json`, power off.

### 5.3 The scratch drive is the only channel, and it is handled unprivileged

The obvious way to build and read an ext4 image is to loop-mount it, which needs `CAP_SYS_ADMIN` — and having taken that capability to read attacker-influenced filesystem metadata, the host kernel's ext4 parser becomes the attack surface. That would trade the boundary away at the last step.

Instead, both directions are userspace:

- **Build:** `mke2fs -d <staging-dir> -t ext4 -b 4096 scratch.ext4 <size>` constructs the image from a directory. No mount, no privilege.
- **Extract:** `debugfs -R "rdump /out <hostdir>" scratch.ext4` reads the results out. No mount, no privilege, and `debugfs` is used strictly read-only.

Scratch size is derived from the declared inputs plus the task's output budget, under a ceiling. The image is created fresh per job, in the jailer's chroot, and deleted after extraction.

### 5.4 Extraction is a trust boundary

Everything under `/job/out` was written by untrusted code. On the host side, after `rdump`:

- Only **regular files** are extracted. Directories are walked; symlinks, devices, FIFOs and sockets are skipped and counted.
- Every relative path is normalised and re-validated against §16 Threat 8's rules before it becomes an asset path — `..`, absolute paths, and unicode-normalisation dodges rejected, then checked against the task's write-grant glob.
- File count, per-file size and total size are capped; a breach is a sandbox kill, not a truncation.
- `emits.jsonl` is size-capped and line-capped before parsing, and each line is `JSON.parse`d individually so one malformed line is one error rather than a failed job.

### 5.5 Host requirements, and what we deliberately do not need

`apps/pyrunner` is a composition root (it initialises telemetry, like `apps/engine` and `apps/web`), running as its own compose service on an **internal** network reachable only by `engine`. The engine talks to it over HTTP; the service has no egress.

It needs **`/dev/kvm` passed through** to the container. It does **not** need `--privileged`, and it never sees the docker socket. That is the whole trade: one device passthrough instead of root-equivalent access to the host daemon.

This development host qualifies — `/dev/kvm` is present and the CPU reports `svm` — but the `firecracker` and `jailer` binaries are not installed anywhere on it and must be vendored, pinned by hash, and baked into the image.

### 5.6 Two backends, and loud degradation

CI runners generally have no nested virtualisation. Rather than pretend, the runner has two backends behind one interface:

- **`firecracker`** — the default whenever `/dev/kvm` is present, and the only backend that is a security boundary.
- **`subprocess`** — rlimits and an unshared netns where the host allows it. Labelled in code, in docs and in its startup log as **not a security boundary**, and refuses to start without `PYRUNNER_ALLOW_UNSAFE_BACKEND=1`.

The hostile corpus runs on `firecracker` only and **skips with a visible message** when KVM is absent — never silently, and never by quietly re-pointing at the subprocess backend, which would turn the sandbox suite into a suite that tests nothing.

### 5.7 No warm pool in v1

Pre-booted VMs would cut ~125 ms and break the guarantee that every job starts from an identical, untouched machine. Firecracker's snapshot-restore makes a safe warm pool possible later — restore from a snapshot taken before any job code ran — but it is an optimisation with a correctness argument attached, and it waits until the latency is measured and found to matter.

## 6. Determinism

Same discipline as the byte-stable PDF rule in S5e, because the same tests depend on it.

Environment: `PYTHONHASHSEED=0`, `PYTHONDONTWRITEBYTECODE=1`, `PYTHONNOUSERSITE=1`, `python -I` (isolated mode), `TZ=UTC`, `SOURCE_DATE_EPOCH` fixed to the run's trigger timestamp, `MPLBACKEND=Agg`, `MPLCONFIGDIR=/job/tmp/mpl`.

`.xlsx` is a zip of XML with creation and modification timestamps in `docProps/core.xml` and an mtime on every zip entry. Both `openpyxl` and `XlsxWriter` allow setting document properties; zip entry times are normalised by the test helper. **Tests normalise timestamps and document ids before comparing**, exactly as the PDF fixtures do — do not try to make the writer emit a byte-identical file by accident.

## 7. Security Analysis (extends `techical_plan.md` §16)

**Threat 18 — Python as arbitrary code execution.** This is not a threat to mitigate but the feature's premise: the author is an LLM or a hurried human, and the program is untrusted. Containment is the microVM (§5.2) — separate kernel, no network device, read-only rootfs, a single per-job scratch drive, 1 vCPU, memory and wall-clock caps, jailer chroot and cgroups, no API socket, no vsock. Nothing about the program's behaviour is inspected or restricted; there is simply nowhere for it to go.

**Threat 19 — Guest-to-host escape through the result channel.** The scratch image is written by hostile code and must be parsed by the host, which is the sharpest edge in this design. Controls: the image is never loop-mounted, so the host kernel's ext4 parser is never exposed to it; construction and extraction are userspace (`mke2fs -d`, `debugfs -R rdump`); only regular files come out; every extracted path is re-validated against Threat 8's rules and the write-grant glob; counts and sizes are capped; `emits.jsonl` is capped and parsed line-by-line (§5.4).

**Threat 20 — Resource exhaustion and abuse.** A workflow that mines cryptocurrency is a plausible outcome of a sufficiently confused agent. Controls: cgroup CPU and memory limits, host wall-clock kill, a concurrent-job cap, and `pyrun_sandbox_kills_total{reason}` on the security-signals dashboard — a series that should sit at zero, which is what makes a deviation loud.

**Threat 21 — Dependency supply chain.** The image *is* the allowlist, pinned by version and hash, rebuilt deliberately rather than on every deploy, with the manifest committed and checked at publish (§4). A compromised package still executes only inside a VM with no network, so the realistic damage is a wrong number in a spreadsheet rather than an exfiltration — which is a real harm and the reason the manifest is reviewed, not a reason to add runtime scanning.

**Threat 22 — Import-time and runtime exfiltration.** Moot, and recorded here so it stays moot: there is no NIC in the VM, no vsock, and no host bridge, so `socket`, `urllib`, `requests` and every transitive equivalent have nothing to open. **This is the single property the whole design rests on.** Any future change that adds a network device, a vsock channel, or a host callable to this sandbox reopens the exfiltration chain §4 was built to sever and requires a design-doc change, not a pull request.

## 8. Observability

New §17.2 catalogue rows, under the binding-name rule:

| Metric | Type | Labels |
|---|---|---|
| `pyrun_jobs_total` | counter | `outcome=ok\|program_error\|sandbox_kill\|infra_error` |
| `pyrun_duration_seconds` | histogram | `outcome` |
| `pyrun_vm_boot_seconds` | histogram | — |
| `pyrun_sandbox_kills_total` | counter | `reason=wall_clock\|memory\|output_cap\|file_count\|bad_path` |
| `pyrun_output_bytes` | histogram | — |

Sandbox kills join renderer kills on the security-signals dashboard, which already reserves that row for "renderer and isolate sandbox kills". The content rules apply unchanged: no source code, no packet bodies, no output contents, no file names in any signal — identifiers, sizes, durations and outcomes only.

Per-job detail — exit code, boot time, stdout/stderr, extracted file list — goes to `trace_entries` (S3a) as a `pyrun` entry kind, under the user's storage opt-outs. The runner keeps no tables of its own.

## 9. Data Model Additions (extends `techical_plan.md` §14)

```
-- tasks gains three nullable columns, all projected from graph_json at publish:
tasks.code_source   text    null      -- the Python program
tasks.code_sha256   text    null      -- feeds the task content hash (graph-compilation-llm §6.3)
tasks.runtime_json  jsonb   null      -- {image, packages[], inputs:{assets[],tables[]}}

-- S5a's named constraint is extended, not replaced:
tasks_kind_mode_check  CHECK (mode IN ('ai','compiled','python')
                        AND NOT (kind = 'asset'  AND mode = 'compiled')
                        AND NOT (kind <> 'asset' AND mode = 'python'))
```

No new tables. The dependency manifest is a file in the repo, not a row — it is reviewed in pull requests, which is the point of it.

## 10. Build Plan Placement

- **S5h — Python compute mode.** Depends on **S5a** (`kind`/`mode` discriminants and the `(kind, mode)` registry) and **S5d** (asset store and `BlobStore`, without which outputs have nowhere to land). A sibling of S5e, and the two are independent of each other.

  Deliverables: `apps/pyrunner` with both backends; the `pyrunner-base` image, kernel, and vendored Firecracker binaries; the job protocol of §3; the `(kind, mode)` tool-registry split; `PythonExecutor` in the engine, calling the runner and publishing emits host-side; the graph-document additions (`code`, `runtime`) and their publish-time validation against the manifest; the compose service and its `/dev/kvm` requirement documented in `infra/README.md`.

  Tests: a hostile corpus in the S5e style, table-driven and extended whenever someone thinks of a new escape — network attempt of every flavour, `subprocess` and `os.system`, fork bomb against the pid limit, memory bomb, infinite loop against the wall clock, writes outside `/job/out`, a symlink out of the scratch dir, an output that exceeds the byte cap, a `../../` path in an output filename, an `emits.jsonl` that is 100 MB of one line. Happy path: a fixture program producing a byte-stable `.xlsx` after timestamp normalisation. Contract: emits validated host-side against the packet schema, a malformed emit failing the run; a sandbox kill failing the run permanently with no retry.

  E2E: the §1 pricing example, replay-deterministic in CI on the subprocess backend, with the sandbox suite gated on KVM.

- **U3 gains** a read-only code viewer with cross-version diff (users must be able to see what will run, the same argument §11 makes for compiled scripts) and `.xlsx` download alongside the PDF preview. No new UI slice.

- **S5g interaction.** The `tables` input (§3.1) lands with S5g, since it needs the workflow store and its reader role. S5h ships with `assets` and `trigger` inputs only, and the graph schema reserves the field.

## 11. Decisions and Open Questions

Resolved in this document:

1. **Python is a mode on `kind=asset`, not a fourth kind** — and the tool registry keys on `(kind, mode)`, so `(asset, python)` has no tools at all.
2. **No host bridge.** Inputs are resolved before boot, outputs collected after exit; the scratch block device is the only channel.
3. **Emits are published host-side**, so packet validation, dedupe, loop budget and the outbox apply unchanged.
4. **Firecracker microVM per job, under `jailer`, with no network device** — chosen over subprocess (not a boundary) and per-job containers (needs the docker socket).
5. **The scratch image is built and read unprivileged** (`mke2fs -d`, `debugfs -R rdump`) — never loop-mounted.
6. **Dependencies are a pinned image manifest**, checked at publish; no runtime `pip`. The manifest is provenance, the VM is the boundary.
7. **Source lives in the graph document** and changes through `publishVersion`, never `updateTask`.
8. **Two backends with loud degradation** — the subprocess backend is not a security boundary, says so, and requires an explicit opt-in env var; the hostile corpus never runs on it.
9. **No warm pool in v1** — identical fresh machines beat 125 ms.

Open:

1. **Snapshot-restore warm pool** (§5.7) — worth it if boot latency shows up in `pyrun_vm_boot_seconds` against real workloads.
2. **Store writes from Python.** Reads arrive as Parquet (§3.1); writes would need either a host-collected write file validated against the table spec, or the job emitting an event an `(asset, ai)` node persists. The second needs no new machinery and should be tried first.
3. **Who authors the code.** S8's graph compiler can write Python as readily as it writes prompts, and the deterministic gate would need a Python analogue — `ast.parse` plus a denylist visitor, run in the runner since Node cannot parse Python. Note that such a gate is defence in depth, not the boundary, so it must never become a *precondition* for publish: coupling the publish path to a running service would be a worse bug than the one it prevents.
4. **Larger inputs.** Parquet materialisation and a scratch drive are fine for tens of megabytes. A job that wants a gigabyte needs a different input strategy and probably a different product answer.
5. **Ceilings.** Concrete defaults for memory, wall clock, output bytes, file count and concurrency want a pass against real BI workloads; the numbers are config, not design.

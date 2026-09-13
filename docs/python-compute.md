# Python compute — the asset agent's `python.run` tool

**Version:** 0.4 (2026-09-11)
**Status:** Current S6d tool and runner contract. Python is not an authorable execution
mode. The [original proposal](history/python-compute-original.md) is archived as history.

## 1. Purpose and scope

An asset agent uses Python for computation: spreadsheets, charts, transformations and
statistical work. The author describes the deliverable in the node's prompt. The agent
writes a program at run time, calls `python.run`, inspects the result and decides what to
emit. It can combine computation, MCP calls, asset writes and rendering in the same run.

For example: a browser emits pricing records; an asset agent calculates changes with Python,
writes a spreadsheet and emits `report.ready`; a browser uploads that asset.

## 2. Placement in the execution model

The editor creates `ai` nodes without a mode selector. `python.run` is always present on
the `(asset, ai)` registry, beside the asset, MCP and workflow-store tools. Without
`PYRUNNER_URL`, the tool returns an unavailable error. Engine status advertises the configured
capability. Browser and decision registries do not expose Python.

The Python program has no tool bridge to the host: it cannot call `emit`, `mcp.*`, `page.*`
or `store.*` through the agent's registry. Asset resolution and asset publication are host
operations. This is distinct from browser [trace compilation](trace-compilation.md), which
uses a completed browser trace to produce a guarded static script.

## 3. Execution contract

`packages/agent/src/python-tool.ts` is the tool boundary. Arguments are:

- `code`: non-empty Python source, at most 200,000 characters.
- `inputs`: up to 50 asset paths, resolved by the host under the owning user's namespace.
- `wall_clock_ms`: optional positive limit, at most 600,000 ms, further restricted by the
  task's `limits_json.python.wall_clock_ms` when configured.

Input assets appear under `in/<basename>`; duplicate basenames are rejected. The program
writes deliverables under `out/files/`, creating subdirectories as needed. Paths are relative
to the job directory, not a per-job `/job` chroot. `TABDUCTOR_JOB_DIR` exposes the absolute
job directory to programs that need it.

The tool currently passes a null trigger to the runner. It does not automatically materialize
the agent's trigger packet or workflow-store tables. The agent supplies needed values through
program source or input assets; store queries remain agent tool calls.

All returned output paths are normalized and checked against task write grants before asset
publication begins. Duplicate destination paths and invalid paths are rejected. Accepted files
become asset versions and their references return to the agent. This validation is not a claim
that separate asset writes roll back atomically after an unrelated storage failure.

Stdout, stderr and optional `out/emits.jsonl` return as bounded, untrusted tool data. The
program does **not** publish events. The agent decides whether to call `emit`; normal schema
validation, deduplication and outbox semantics then apply.

Program errors, timeouts, output-cap violations and runner unavailability are tool errors.
They are not automatically permanent workflow-run failures; the agent's response and the
normal run policy determine the execution outcome.

## 4. Dependencies

The pinned runtime is `py-2026.08`; the committed `PYTHON_RUNTIME_MANIFEST` defines its
available packages. The tool advertises those packages. There is no per-node Python dependency
selector at publish time, and runtime package installation is not a supported workflow.

## 5. Runner and isolation

`apps/pyrunner` runs Python as a subprocess. The self-hosted Compose deployment places the
runner on an internal compute network with no published port. The container is the deployment
isolation unit, not a per-job Firecracker VM. No `/dev/kvm`, jailer, guest filesystem image,
Docker socket or alternate microVM backend is required.

Wall-clock termination, bounded outputs, symlink handling and host-side path/grant checks
remain enforced contracts. CPython is not restricted from creating sockets or subprocesses;
network reachability depends on deployment topology. Internal Compose networking must not be
described as an absent NIC or a guarantee of no intra-network access.

## 6. Determinism

The runner uses the pinned image and an explicit environment, including a fixed Python hash
seed and a supplied source-date epoch. Python uses `-s -B`, not `-I`, so that hash seed remains
effective. Programs and archive-producing libraries must also control their own timestamps
and randomness. The tool supplies the current epoch, so separate calls are not promised to
produce byte-identical files merely because their source is identical.

## 7. Trust boundary

Runner responses are untrusted. The host validates paths, grants and output limits before
publishing assets. Program text and results are not authority to bypass tool or event checks.
The retired microVM hostile corpus does not describe this subprocess runner's guarantees.

## 8. Observability

Python calls belong to the asset execution trace. The runner records job outcomes and
duration through `pyrun_jobs_total`, `pyrun_duration_seconds`, `pyrun_kills_total` and
`pyrun_output_bytes`. There is no VM-boot metric. Platform telemetry excludes program source,
input data and output content.

## 9. Data model

Migration `0019_modes_model` removed `tasks.code_source`, `tasks.code_sha256` and
`tasks.runtime_json`. Python code is a runtime tool argument; outputs use the existing asset
tables. `engine_status.capabilities` includes `python.run` when configured.

## 10. Verification and remaining work

Tool/runner tests cover configured and unavailable calls, input resolution, output paths and
grants, wall-clock/output limits, program errors, deterministic fixtures and replayed agent
calls. Automated tests may use stub executors to supply upstream packets. The UI does not.
Automatic materialization of workflow-store tables is not implemented by the tool.

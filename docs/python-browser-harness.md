# Python browser runtime deployment

The supported browser runtime is Python plus Camoufox. See [harness-summary.md](harness-summary.md) for the API, transport, state and compilation architecture.

## Configuration

The engine requires `PYTHON_RUNNER_URL` and `PYTHON_RUNNER_TOKEN`. `BROWSER_AGENT_BACKEND`, if set, must be `python`; `BROWSER_MODE`, if set, must be `fleet`. There is no JavaScript/CDP fallback. The Python runner, worker and engine must be deployed together: runner protocol v4, Playwright API `playwright-python-v1`, operation evidence v3.

- Local: `pnpm local:up` builds the worker, broker and execution images, provisions the broker token and includes `docker-compose.python.yml`.
- Staging: `pnpm staging:up` builds/loads the Python images and enables the runner chart.
- AWS: build/push scripts publish the application, worker, broker and execution images; `scripts/aws/deploy.py` enables the runner using pinned image digests. `scripts/aws/configure.mjs` provisions its secret.
- Helm: `pythonRunner.enabled` defaults to true and cannot be disabled. Execution pods require a NetworkPolicy-enforcing CNI. The broker has narrowly scoped pod management/attach permissions; execution pods have no service-account token and a deny-all network policy.

Configuration lives in [engine main](../apps/engine/src/main.ts), [containers.ts](../apps/python-runner/src/containers.ts), [chart](../infra/helm/tabductor/templates/python-runner.yaml), [local startup](../scripts/local/up.mjs), [staging startup](../scripts/staging/up.sh) and [AWS deploy](../scripts/aws/deploy.py).

Drain active runs before upgrading. Publish the vendored fork commit before remote builds that initialize submodules. Migration 0050 retires incompatible artifacts and pending compilation jobs; affected tasks collect fresh AI evidence before compilation. Reverting only the backend flag is not a supported rollback.

## Persistence and isolation

One run-bound Python interpreter serves successive cells. Variables and browser object references persist while that interpreter remains connected. `/workspace` files are checkpointed after normal completion, Python exceptions and terminal calls, and are restored if the interpreter restarts. The separately leased browser retains its state. Interrupted cells are not automatically repeated.

The execution container has a read-only root, non-root UID, dropped capabilities, resource limits and no direct network or infrastructure credentials. Website operations travel through the engine gateway to the owned browser. The broker has infrastructure access only to manage sandboxes. [Container tests](../tests/system/python-runner-container.test.ts) verify these boundaries.

Helpers are versioned in `agent_helpers.py`; their initialization cannot issue browser effects. Output is retained with a bounded model preview and can be paged through `browser.output.read`. `browser.history.read` retrieves the durable operation archive. Storage opt-outs and sensitive evidence can prevent compilation.

The separate `browser.network` tool accepts `{ "action": "list", "urlPattern": "/api" }` to return earlier requests with stable indexes, method, URL, resource type, status and timings. `{ "action": "read", "index": 0, "parts": ["response_body"] }` reads selected request or response headers and bodies. Body values contain MIME type, size and bounded text. Browser navigation, page interactions and network reads have no policy gate; run ownership and resource limits still apply.

Browser continuity retains workspace and exploration context across runs within one workflow execution/task/runtime scope. Per-record checkpoints, effect journals and completion/accounting remain separate. A failed browser operation may have committed; AI can inspect and reconcile it, while compiled execution deopts before further effects.

## Acceptance

`pnpm test:python-harness` builds disposable Docker services and exercises:

- Authentication, network/filesystem isolation and runaway/cancelled Python.
- Login recovery with the uncertain-effect journal.
- Python compilation, current-input replay without model calls, layout deopt and delayed-write reconciliation.
- A file-backed 100-row dataset, static execution, and partial-write recovery without duplicate identities.

`node scripts/test-python-runner-kubernetes.mjs` tests the broker in an isolated temporary namespace on the staging kind cluster and removes it afterward. Fixtures are synthetic; neither command requires live customer accounts.

# Browser-node learning

The agent-facing API does not expose checkpoints, operation-progress/status tools,
or dedicated verification helpers. Normal Playwright assertions remain available,
but completion does not require one. Internal effect tracking and compiler replay
validation remain in place. Apply migration `0054_remove_save_verification_gate`
before running this version; reported saves no longer require a stored proof.
Runtime `tabductor-python-playwright-v2` sends older artifacts to AI fallback.

Browser learning has three independent outputs: an improved node operating prompt,
artifact-scoped deopt instructions, and a recommendation to compile a successful trace.
The human's workflow request and generated task contract remain authoritative.

AI runs, compiled runs that hand off to AI, and static failures enqueue a durable
`browser_learning_jobs` row. A separate worker reads the retained trace only after
the run settles. Clean static successes update reliability statistics without a
learning-model call. New executions use the latest completed prompt revision and
never wait for learning. Model calls use the workflow's configured model/funding
under the `browser_learning` purpose, separate from runtime and trace compilation.

The learner receives the baseline, previous accepted lessons, current outcome,
bounded trace evidence with references, and any artifact/handoff scope. Its output
consolidates ordered successful steps, preconditions, current-input bindings,
and cautions. Failed runs can update cautions but cannot replace a
proven procedure. Missing or oversized evidence is not reconstructed from private
workspace state. Every lesson must cite supplied or previously accepted evidence.

`browser_prompt_revisions` retains provenance and history. The active operating
prompt is materialized in `tasks.compiled_prompt`, starting with a learned-procedure
block. `baseline_compiled_prompt` retains the publish-time baseline. The block is
part of the system instructions, so tool-history compaction cannot remove it.
Learning does not modify the node's task definition or its content hash.

Deopt revisions use the artifact's source/metadata fingerprint plus `recovery` or
`planned:<handoff-id>`. Recovery loads the current matching revision, task prompt,
and current handoff evidence and prior tool results. Static source and planned handoff
boundaries remain unchanged. A replacement artifact starts with its own validated
prompts; the compiler also receives the source run's learning as non-authoritative
guidance. An artifact without a learned deopt revision uses its embedded prompt.

The learner judges minimal resistance; no fixed retry-count threshold applies.
Compilation still requires successful, unassisted, complete SDK evidence with no
unresolved effects, followed by the existing operation-grounding and isolated Python
replay checks. Prompt updates survive compiler refusal. Planned handoffs do not
count toward demotion; three unexpected deopts in the last ten compiled runs still
demote the artifact.

Jobs are serialized per node, have fenced renewable claims, a two-minute model
timeout, and up to three attempts with 30-second retry backoff. A compilation
recommendation remains pending when that node already has an open compile job.
Both prompt application and artifact activation recheck source identity. A stale
worker cannot apply a second revision or replace a newer artifact.

Publishing carries compatible lessons for the same logical node, content hash,
and runtime. A regenerated graph brief retains observed lessons but drops the old
rewritten prose; changed task intent starts fresh. Deopt revisions carry only with
the identical artifact. Memory is not shared between workflows or unrelated nodes.

Migration `0053_browser_learning` adds the queue, revision history, task baseline,
and compile provenance. It initializes baselines without changing active scripts.
Learning is prospective; historical runs are not backfilled. Legacy queued compile
jobs without a learning recommendation are refused by the worker.

Coverage: `tests/system/browser-learning.test.ts` exercises persistence, independent
prompt lanes, compiler admission/refusal, concurrency, edit fencing and publication;
`packages/agent/src/learning-evidence.test.ts` covers evidence grounding and bounds.

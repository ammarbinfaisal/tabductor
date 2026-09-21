# Workflow results

Start with a **Workflow prompt** and an optional **Result schema**. The prompt directs the entire workflow, including what to return. There is no chat-to-prompt step or separate result prompt. Creation builds and publishes the workflow; it does not run it. Edit these same two inputs and rebuild to change the workflow.

Every workflow built from a prompt gets an internal result node. Existing published workflows retain their behavior until rebuilt.
The result node runs once all task attempts and event deliveries have settled. It receives this execution's event packets and task outcomes, including errors. It cannot browse, call tools, emit events, or start more workflow work. Emit any facts needed for the final result from the preceding tasks; the result node does not query the workflow store or browser traces.

The node supports an optional [JSON Schema draft-07](https://json-schema.org/draft-07/draft-handrews-json-schema-01) object or boolean. Schemas are checked at publication; JSON output is validated without coercion or removal of fields. Local references and standard formats are supported; remote references are not fetched. Without a schema, any valid JSON value is accepted, including arrays, scalars, and `null`.

## Configure through MCP

`workflow_publish` accepts just `prompt` and optional `result_schema`. `workflow_update` takes these same inputs plus `workflow_id`; supply the complete updated prompt. Omitting the schema means unrestricted JSON.

```json
{
  "prompt": "Collect the latest articles, then return their count and a short summary.",
  "result_schema": {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": {
      "count": { "type": "integer", "minimum": 0 },
      "summary": { "type": "string" }
    },
    "required": ["count", "summary"],
    "additionalProperties": false
  }
}
```

The tRPC creation endpoint is `workflow.createFromPrompt({ prompt, resultSchema? })`. It returns `workflowId` and `versionId`. The workflow name is derived from the prompt. The compiler receives the schema so preceding tasks gather the evidence needed for the final output. The schema is retained exactly, rather than rewritten by the model.

The graph API represents this as a task with `kind: "result"`, `mode: "ai"`, `prompt`, and optional `resultSchema`. Only one result node is allowed. Set `entry: false`, `emits: []`, `consumes: []`, and `schedule: null`; finalization is automatic.

## Trigger and poll

1. Call MCP `workflow_trigger` with `workflow_id` (or tRPC `workflow.trigger` with `workflowId`). Save the returned `executionId`. Reuse `request_id` / `requestId` when retrying an uncertain trigger response.
2. Poll MCP `workflow_status` with `workflow_id` and `execution_id`, or tRPC `workflow.status` with `workflowId` and `executionId`.
3. Wait until `finished` is `true`. When `resultReady` is `true`, `result` contains the persisted JSON value.

```json
{
  "workflowId": "wf_...",
  "executionId": "exec_...",
  "versionId": "wfv_...",
  "status": "succeeded",
  "finished": true,
  "resultReady": true,
  "result": { "count": 12, "summary": "Collected twelve articles." },
  "errors": [],
  "createdAt": "...",
  "endedAt": "..."
}
```

`status` is `running`, `succeeded`, `failed`, or `cancelled`. Final JSON generation is part of `running`; no partial output is exposed. `resultReady` distinguishes a valid JSON `null` result from an unavailable result. Polls are scoped to the owning account, workflow, and exact execution, so concurrent invocations cannot read each other's results accidentally. Republishing does not change an execution's pinned result definition.

Failed workflow work can still produce a result describing the failure, with `status: "failed"`. Cancelling skips finalization; cancelling an active result run discards any late output. Generation has at most three JSON validation attempts and a default two-minute run deadline, configurable with `limits.run_timeout_ms`. Generation/validation failure produces a failed execution with no result. Finalization uses one reserved run outside the traversal run budget and does not publish task lifecycle events. `errors` lists task attempt errors, including earlier failed attempts subsequently recovered by retries.

Apply database migration `0041_fast_william_stryker.sql` before deploying the updated engine and web app. Polling and result persistence work across process restarts; generation interrupted by a crash follows the existing stale-run recovery behavior.

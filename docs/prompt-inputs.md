# Prompt inputs

Write variables directly in the directing workflow prompt:

> Open the editor at $editor-url and write a post about $topic using $writing-style.

Publish the workflow, fill in the generated input fields, and run it. Inputs are required
text values, supplied per manual trigger. Repeated references share a value. Names start
with a letter or underscore and can contain letters, digits, underscores and hyphens.
`$$` escapes a literal dollar sign; `$20` is a price, not an input.

The tRPC `browser.trigger` mutation accepts:

```json
{
  "workflowId": "wf_...",
  "requestId": "unique-invocation-id",
  "inputs": {
    "editor-url": "https://example.com/editor",
    "topic": "community gardens",
    "writing-style": "A friendly, concise paragraph"
  }
}
```

MCP `workflow_trigger` accepts the same `inputs` object with `workflow_id` and optional
`request_id`. Keys omit the `$`. Reuse a request ID to retry the same invocation; use a new
ID for a new run. Missing, blank, unknown, or oversized inputs are rejected before work is
queued. Each value can contain up to 20,000 characters; an invocation supports at most 100
values with a combined serialized limit of 100,000 characters.

The manual trigger event stores the values under `promptInputs`. Browser and decision
tasks receive the same values throughout that execution, including downstream tasks and
retries. In browser Python, literal values are available as
`browser.input["promptInputs"]["editor-url"]`. Input values are data, never Python source.
Schedules do not supply prompt inputs; use manual runs for parameterized workflows.

## Static execution with AI portions

Variable-dependent semantic work can remain inside a compiled browser routine:

```python
def run(page, context, browser):
    try:
        page.goto(browser.input["promptInputs"]["editor-url"])
        editor = page.get_by_role("textbox", name="Post")
        if editor.count() != 1:
            browser.deopt(reason="The post editor changed")
        answer = browser.ai(
            "Write a post about $topic using $writing-style",
            {"type": "object", "properties": {"text": {"type": "string"}},
             "required": ["text"], "additionalProperties": False},
        )
        editor.fill(answer["text"])
        browser.done()
    except Exception as error:
        browser.deopt(reason=str(error))
```

The host resolves references inside `browser.ai` against the current execution's values
on every call. Substitution happens once, so dollar signs, quotes, and newlines inside a
value remain data. Missing references fail the call. The AI call returns schema-validated
JSON; subsequent static browser operations use its fresh response.

Compilation preserves observed AI calls, their schemas, and current-input bindings.
It does not need to hand the entire remaining workflow back to an agent merely because
one portion requires AI. Replay checks vary input values and unconstrained AI response
fields to catch scripts that bake in the example run's values or answers. Normal evidence,
guard, and compilation eligibility checks still apply.

import type { Context } from "@/context";
import type { Resource, ResourceResult } from "@/resources/resource";

type StaticResourceDefinition = {
  uri: string;
  name: string;
  description: string;
  text: string;
};

function createStaticResource(definition: StaticResourceDefinition): Resource {
  return {
    schema: {
      uri: definition.uri,
      name: definition.name,
      description: definition.description,
      mimeType: "text/markdown",
    },
    read: async (_context: Context, uri: string): Promise<ResourceResult[]> => [
      {
        uri,
        mimeType: "text/markdown",
        text: definition.text,
      },
    ],
  };
}

export const llmWorkflowGuide = createStaticResource({
  uri: "browsermcp://guides/llm-workflow",
  name: "Browser MCP LLM Workflow",
  description:
    "Recommended Browser MCP workflow for LLM agents, including overview, actionable discovery, and follow-up reads.",
  text: `# Browser MCP LLM Workflow

Use this order when driving a page through the MCP tools:

1. Call \`browser_sessions\` and choose a \`sessionId\`.
2. Call \`browser_session_overview\` first when you need to orient on a page quickly.
3. Call \`browser_actionables\` with filters when you need concrete refs. It is bounded by default, so tighten the query before raising limits.
4. Call \`browser_find_text\` when the next step is “find the best clickable thing matching this text”.
5. Call \`browser_run_js\` when the model needs page-local batching across many targets or records, especially for discover/filter/check/dry-run/apply flows that would otherwise require many separate MCP calls. Return structured data and use \`console.log\` for live debug output.
6. Call \`browser_describe_ref\` only for the specific ref that needs deeper context.
7. Call \`browser_snapshot\` only when grouped refs are not enough and you need a broader semantic tree. Treat it as a compact semantic snapshot, not a full DOM or full URL inventory.
8. Use action tools with the same explicit \`sessionId\`. Treat \`ref\` as the primary handle; \`element\` is optional metadata.
9. Prefer the action response first; when the page version advances, it already includes \`nextDiscovery\` and \`nextRefs\`.
10. Read \`browser_state\` only when you need metadata or change summaries without another discovery read.

Heuristics:

- Prefer \`browser_session_overview\` over \`browser_snapshot\` for initial page orientation.
- Prefer \`browser_actionables\` over \`browser_snapshot\` when you already know you need DOM refs.
- Prefer \`browser_find_text\` over a broad snapshot when you can name the thing you want.
- Prefer \`browser_run_js\` over many small action calls when the task is naturally batch-shaped and the model needs shared local logic for selection, validation, planning, or conditional execution.
- If a visible target or href is missing from \`browser_snapshot\`, use \`browser_actionables\` with filters or \`browser_describe_ref\`; do not assume the snapshot is a full-page DOM dump.
- Treat \`sessionId\` as stable for a tab across reconnects.
- Treat \`pageVersion\` as the current interaction version for that page.
- Use \`browser_navigate\` with \`waitUntil\` when navigation timing matters.
- Use multiple sessions in parallel, but keep writes on the same session sequential.`,
});

export const llmWorkflowGuideAlias = createStaticResource({
  uri: "tabductor://guides/llm-workflow",
  name: "Tabductor LLM Workflow",
  description:
    "Recommended Tabductor workflow for LLM agents, including overview, actionable discovery, and follow-up reads.",
  text: `# Tabductor LLM Workflow

Use the same workflow as \`browsermcp://guides/llm-workflow\`.
`,
});

export const staleRefGuide = createStaticResource({
  uri: "browsermcp://guides/stale-ref-recovery",
  name: "Browser MCP Stale Ref Recovery",
  description:
    "How to recover from stale refs and use action responses without over-fetching snapshots.",
  text: `# Browser MCP Stale Ref Recovery

Browser MCP treats refs as snapshot-derived handles. If the page changes, a ref may go stale.

When an action returns \`STALE_REF\`:

1. Read the attached \`nextDiscovery\` bundle in the same error response.
2. Pick the refreshed ref from the updated grouped inventory.
3. Retry the action with the new ref.

Guidance:

- Pass \`pageVersion\` when you want strict stale-ref detection.
- Omit \`pageVersion\` when you prefer best-effort execution against the latest page state.
- Read the action response before requesting a fresh snapshot; when the page version advances, Browser MCP already attaches the next-step discovery bundle.
- Use \`browser_state\` when you only need current page metadata and the latest change summary.`,
});

export const staleRefGuideAlias = createStaticResource({
  uri: "tabductor://guides/stale-ref-recovery",
  name: "Tabductor Stale Ref Recovery",
  description:
    "How to recover from stale refs and use action responses without over-fetching snapshots.",
  text: `# Tabductor Stale Ref Recovery

Use the same recovery guidance as \`browsermcp://guides/stale-ref-recovery\`.
`,
});

export const guideResources: Resource[] = [
  llmWorkflowGuide,
  llmWorkflowGuideAlias,
  staleRefGuide,
  staleRefGuideAlias,
];

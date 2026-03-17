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
3. Call \`browser_actionables\` when you need concrete refs grouped by semantic area.
4. Call \`browser_describe_ref\` only for the specific ref that needs deeper context.
5. Call \`browser_snapshot\` only when grouped refs are not enough and you need a broader semantic tree.
6. Use action tools with the same explicit \`sessionId\`.
7. Read the action response or \`browser_state\` before forcing another snapshot.

Heuristics:

- Prefer \`browser_session_overview\` over \`browser_snapshot\` for initial page orientation.
- Prefer \`browser_actionables\` over \`browser_snapshot\` when you already know you need DOM refs.
- Treat \`sessionId\` as stable for a tab across reconnects.
- Use multiple sessions in parallel, but keep writes on the same session sequential.`,
});

export const staleRefGuide = createStaticResource({
  uri: "browsermcp://guides/stale-ref-recovery",
  name: "Browser MCP Stale Ref Recovery",
  description:
    "How to recover from stale refs and use action responses without over-fetching snapshots.",
  text: `# Browser MCP Stale Ref Recovery

Browser MCP treats refs as snapshot-derived handles. If the page changes, a ref may go stale.

When an action returns \`STALE_REF\`:

1. Re-read \`browser_actionables\` for the same \`sessionId\`.
2. Pick the refreshed ref from the updated grouped inventory.
3. Retry the action with the new ref.

Guidance:

- Pass \`snapshotVersion\` when you want strict stale-ref detection.
- Omit \`snapshotVersion\` when you prefer best-effort execution against the latest page state.
- Read the action response before requesting a fresh snapshot; many follow-up decisions can be made from the returned change summary.
- Use \`browser_state\` when you only need current page metadata and the latest change summary.`,
});

export const guideResources: Resource[] = [llmWorkflowGuide, staleRefGuide];

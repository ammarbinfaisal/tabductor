import { StoreBrowser } from "../../../../components/store-browser.js";

export const dynamic = "force-dynamic";

/**
 * U3.5's store browser: a workflow sub-route, not a global page like `/endpoints`
 * (U1.5's own placement argument). `cdp_endpoints` has no `workflow_id` — one connection is
 * account-wide, so a per-workflow page would either repeat the same global list everywhere
 * or need a filter the schema can't express. The store is the opposite: `wfdata_<id>` is
 * *defined* per workflow (graph-compilation-llm §3.2), so it belongs beside Runs/Events/Share
 * on this workflow's own tabbar (`workflows/[id]/layout.tsx`), not promoted to a global nav
 * item for data that never spans more than one workflow.
 */
export default async function StorePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StoreBrowser workflowId={id} />;
}

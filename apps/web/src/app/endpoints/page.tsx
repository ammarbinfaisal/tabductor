import { EndpointHealth } from "../../components/endpoint-health.js";

/**
 * Global endpoint health (U1.5) — `cdp_endpoints` are account-wide, not workflow-scoped,
 * so this sits beside `/status` in the top-level nav rather than inside a workflow's hub.
 */
export const dynamic = "force-dynamic";

export default function EndpointsPage() {
  return <EndpointHealth />;
}

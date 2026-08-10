import { WorkflowRuns } from "../../../../components/runs-table.js";

export const dynamic = "force-dynamic";

export default async function RunsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WorkflowRuns workflowId={id} />;
}

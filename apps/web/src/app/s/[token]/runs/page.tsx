import { SharedRuns } from "../../../../components/runs-table.js";

export const dynamic = "force-dynamic";

export default async function SharedRunsPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SharedRuns token={token} />;
}

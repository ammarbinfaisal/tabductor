import { SharePanel } from "../../../../components/share-panel.js";

export const dynamic = "force-dynamic";

export default async function SharingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SharePanel workflowId={id} />;
}

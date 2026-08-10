import { WorkflowEvents } from "../../../../components/event-feed.js";

export const dynamic = "force-dynamic";

export default async function EventsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ event?: string }>;
}) {
  const { id } = await params;
  const { event } = await searchParams;
  return <WorkflowEvents workflowId={id} initialEventId={event ?? null} />;
}

import { SharedEvents } from "../../../../components/event-feed.js";

export const dynamic = "force-dynamic";

export default async function SharedEventsPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SharedEvents token={token} />;
}

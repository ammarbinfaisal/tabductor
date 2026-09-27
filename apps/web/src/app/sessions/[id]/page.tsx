import { createServerCaller } from "../../../server/router.js";
import { SessionInspector } from "../../../components/session-inspector.js";
export const dynamic = "force-dynamic";
export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await createServerCaller();
  const { session } = await caller.browserSession.get({ sessionId: id });
  return <SessionInspector key={id} sessionId={id} profileSession={session.executionId === null} />;
}

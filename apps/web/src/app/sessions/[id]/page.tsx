import { createServerCaller } from "../../../server/router.js";
import { SessionInspector } from "../../../components/session-inspector.js";
export const dynamic = "force-dynamic";
export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await createServerCaller();
  await caller.browserSession.get({ sessionId: id });
  return <><h1>Browser session</h1><SessionInspector sessionId={id} /></>;
}

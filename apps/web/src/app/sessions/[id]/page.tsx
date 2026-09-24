import Link from "next/link";
import { createServerCaller } from "../../../server/router.js";
import { SessionInspector } from "../../../components/session-inspector.js";
export const dynamic = "force-dynamic";
export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await createServerCaller();
  await caller.browserSession.get({ sessionId: id });
  return <><div className="page-heading"><div><Link className="eyebrow" href="/sessions">← All sessions</Link><h1>Browser session</h1><p className="mono muted">{id.slice(0, 12)}</p></div></div><SessionInspector key={id} sessionId={id} /></>;
}

import Link from "next/link";
import { createServerCaller } from "../../server/router.js";
import { Stamp } from "../../components/primitives.js";
import { sessionPresentation } from "../../lib/session-presentation.js";
export const dynamic = "force-dynamic";
export const metadata = { title: "Browser sessions" };
export default async function SessionsPage() {
  const sessions = await (await createServerCaller()).browserSession.list();
  const live = sessions.filter(session => !sessionPresentation(session.status).stopped).length;
  return <>
    <div className="page-heading"><div><span className="eyebrow">Browser control</span><h1>Sessions<span className="heading-count">{sessions.length.toString().padStart(2, "0")}</span></h1><p className="muted">Watch your workflows in motion. Revisit them when they stop.</p></div><span className="session-count">{live} active</span></div>
    <div className="table-scroll"><table className="ledger"><thead><tr><th>Session</th><th>Status</th><th>Control</th><th>Created</th><th><span className="sr-only">Open session</span></th></tr></thead><tbody>
      {sessions.map(session => <tr key={session.id}><td><Link className="session-name" href={`/sessions/${session.id}`}>Browser <span className="mono muted">{session.id.slice(0, 12)}</span></Link></td><td><Stamp kind={session.status} /></td><td>{session.inputOwner === "human" ? "You" : session.inputOwner === "ai" ? "Automation" : "Paused"}</td><td className="mono muted">{session.createdAt.toLocaleString()}</td><td><Link className="btn btn--quiet" href={`/sessions/${session.id}`}>{sessionPresentation(session.status).stopped ? "View session →" : "Watch live ↗︎"}</Link></td></tr>)}
    </tbody></table></div>
    {!sessions.length ? <div className="viewer-empty"><h2>No sessions yet</h2><p>Start a browser workflow to watch it live, or open a profile to sign in.</p><Link className="btn btn--primary" href="/workflows">Open workflows →</Link></div> : null}
  </>;
}

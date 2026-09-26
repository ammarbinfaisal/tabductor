import Link from "next/link";
import { createServerCaller } from "../../server/router.js";
import { Stamp } from "../../components/primitives.js";
import { sessionPresentation } from "../../lib/session-presentation.js";
export const dynamic = "force-dynamic";
export const metadata = { title: "Browser sessions" };
export default async function SessionsPage({searchParams}:{searchParams:Promise<{cursor?:string;direction?:string}>}) {
  const query=await searchParams;
  const page = await (await createServerCaller()).browserSession.list({...(query.cursor?{cursor:query.cursor}:{}),direction:query.direction==="previous"?"previous":"next"});
  const sessions=page.items, live=page.active;
  return <>
    <div className="page-heading"><div><span className="eyebrow">Browser control</span><h1>Sessions<span className="heading-count">{page.total.toString().padStart(2, "0")}</span></h1><p className="muted">Watch your workflows in motion. Revisit them when they stop.</p></div><span className="session-count">{live} active</span></div>
    <div className="table-scroll"><table className="ledger"><thead><tr><th>Session</th><th>Status</th><th>Control</th><th>Created</th><th><span className="sr-only">Open session</span></th></tr></thead><tbody>
      {sessions.map(session => <tr key={session.id}><td><Link className="session-name" href={`/sessions/${session.id}`}>{session.workflowName ?? session.profileName ?? "Browser session"}</Link></td><td><Stamp kind={session.status} /></td><td>{session.inputOwner === "human" ? "You" : session.inputOwner === "ai" ? "Automation" : "Paused"}</td><td className="mono muted">{session.createdAt.toLocaleString()}</td><td><Link className="btn btn--quiet" href={`/sessions/${session.id}`}>{sessionPresentation(session.status).stopped ? "View session →" : "Watch live ↗︎"}</Link></td></tr>)}
    </tbody></table></div>
    <nav className="row" aria-label="Session pages">
      {page.previousCursor?<Link className="btn" href={`/sessions?direction=previous&cursor=${encodeURIComponent(page.previousCursor)}`}>← Previous</Link>:<span className="btn" aria-disabled="true">← Previous</span>}
      <span className="muted">{sessions.length} of {page.total} sessions</span>
      {page.nextCursor?<Link className="btn" href={`/sessions?cursor=${encodeURIComponent(page.nextCursor)}`}>Next →</Link>:<span className="btn" aria-disabled="true">Next →</span>}
    </nav>
    {!sessions.length ? <div className="viewer-empty"><h2>No sessions yet</h2><p>Start a browser workflow to watch it live, or open a profile to sign in.</p><Link className="btn btn--primary" href="/workflows">Open workflows →</Link></div> : null}
  </>;
}

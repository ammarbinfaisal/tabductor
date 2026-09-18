import Link from "next/link";
import { createServerCaller } from "../../server/router.js";
export const dynamic = "force-dynamic";
export default async function SessionsPage() {
  const caller = await createServerCaller();
  const sessions = await caller.browserSession.list();
  return <><h1>Browser sessions</h1><p>Inspect live browsers, take over for login, and review recordings.</p><ul>
    {sessions.map((session) => <li key={session.id}><Link href={`/sessions/${session.id}`}>{session.id}</Link> · {session.status} · {session.inputOwner}</li>)}
  </ul>{!sessions.length ? <p>No sessions yet. Start a browser workflow or open profile setup from its settings.</p> : null}</>;
}

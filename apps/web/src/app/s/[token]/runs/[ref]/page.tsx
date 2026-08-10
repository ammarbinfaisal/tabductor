import Link from "next/link";
import { notFound } from "next/navigation";
import { TRPCError } from "@trpc/server";
import { shareCaller } from "../../../../../server/share-caller.js";

export const dynamic = "force-dynamic";

/**
 * One run, addressed by its share-scoped ref (U0.5). Server-rendered rather than polled:
 * a finished run does not change, and an unfinished one is what the runs table is for.
 *
 * Note what is *not* here: no error message, only the class the read model derived. Run
 * error text is executor-authored free text and never leaves the owner's view.
 */
export default async function SharedRunPage({
  params,
}: {
  params: Promise<{ token: string; ref: string }>;
}) {
  const { token, ref } = await params;
  const api = await shareCaller();
  const detail = await api.public.run({ token, ref }).catch((err: unknown) => {
    if (err instanceof TRPCError) notFound();
    throw err;
  });

  const { run, trigger, emitted } = detail;
  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>{run.taskName}</h1>
        <Link href={`/s/${encodeURIComponent(token)}/runs`} className="muted">
          all runs
        </Link>
      </div>

      <div className="panel">
        <div className="row" style={{ gap: 16 }}>
          <span className={`status status-${run.status}`}>{run.status}</span>
          <span className="muted">attempt {run.attempt}</span>
          <span className="muted">mode {run.mode}</span>
          {run.errorClass ? <span className="muted">failed: {run.errorClass}</span> : null}
        </div>
        <p className="mono muted">
          started {run.startedAt?.toLocaleString() ?? "—"} · ended {run.endedAt?.toLocaleString() ?? "—"}
        </p>
      </div>

      <h3>Triggered by</h3>
      {trigger ? <EventCard event={trigger} /> : <p className="muted">No trigger event.</p>}

      <h3>Emitted</h3>
      {emitted.length === 0 ? (
        <p className="muted">This run emitted nothing.</p>
      ) : (
        emitted.map((event) => <EventCard key={event.ref} event={event} />)
      )}
    </>
  );
}

function EventCard({
  event,
}: {
  event: { ref: string; type: string; occurredAt: Date; packetPublic: boolean; packet?: unknown };
}) {
  return (
    <div className="emit">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <code>{event.type}</code>
        <span className="mono muted">{event.occurredAt.toLocaleTimeString()}</span>
      </div>
      {event.packetPublic ? (
        <pre className="mono">{JSON.stringify(event.packet, null, 2)}</pre>
      ) : (
        <p>
          <em className="muted">packet not shared</em>
        </p>
      )}
    </div>
  );
}

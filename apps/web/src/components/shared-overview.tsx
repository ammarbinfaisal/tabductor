"use client";

type PublicOutputEvent = { type: string; public: boolean; packetSchema?: Record<string,unknown> };
import { VisibilityStamp } from "./primitives.js";

/** Behavior-level shared overview; internal execution topology never reaches this component. */
export function SharedOverview({
  name,
  overview,
}: {
  name: string;
  overview: { scheduledTriggers: number; sharedOutputs: PublicOutputEvent[] };
}) {
  return (
    <>
      <div className="row row--between">
        <h1>{name}</h1>
        <span className="section-label">read-only shared view</span>
      </div>

      <div className="editor-panels">
        <section className="panel-region">
          <span className="section-label">Execution</span>
          <div className="ruled">
            <div className="entity-card">
              <div className="row row--between">
                <span>Schedule</span>
                <span className="mono">
                  {overview.scheduledTriggers === 0
                    ? "on demand"
                    : `${overview.scheduledTriggers} active trigger${overview.scheduledTriggers === 1 ? "" : "s"}`}
                </span>
              </div>
            </div>

          </div>
        </section>

        <section className="panel-region">
          <span className="section-label">Shared outputs</span>
          <div className="ruled">
            {overview.sharedOutputs.length === 0 ? (
              <p className="muted">The owner has not shared any output data.</p>
            ) : overview.sharedOutputs.map((event) => (
              <div key={event.type} className="entity-card entity-card--event">
                <div className="row row--between">
                  <span className="mono" style={{ color: "var(--event-text)", fontWeight: 500 }}>
                    ◈ {event.type}
                  </span>
                  <VisibilityStamp isPublic={event.public} />
                </div>
                {event.packetSchema ? (
                  <span className="mono muted" style={{ fontSize: "var(--text-xs)" }}>
                    fields:{" "}
                    {Object.keys((event.packetSchema.properties as object) ?? {}).join(" · ") || "any"}
                  </span>
                ) : (
                  <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
                    Packet withheld by the owner.
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

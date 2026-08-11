"use client";

import type { PublicGraph } from "@tabductor/engine";
import { NODE_KINDS } from "../lib/node-kinds.js";
import { DerivedMap } from "./derived-map.js";
import { EventChip, ScheduleChip, VisibilityStamp } from "./primitives.js";

/**
 * The graph as a share viewer sees it (U0.5/U1): the same derived map the editor renders —
 * not a second renderer that happens to look similar — plus the declarations, read-only.
 * There is no store behind this and no mutation reachable from it: the component takes a
 * document and draws it.
 */
export function SharedGraph({
  name,
  graph,
  maxHops,
}: {
  name: string;
  graph: PublicGraph;
  maxHops: number;
}) {
  return (
    <>
      <div className="row row--between">
        <h1>{name}</h1>
        <span className="section-label">read-only shared view</span>
      </div>

      <section className="map-region">
        <DerivedMap
          tasks={graph.tasks}
          kinds={Object.fromEntries(graph.tasks.map((t) => [t.name, t.kind]))}
          maxHops={maxHops}
        />
      </section>

      <div className="editor-panels">
        <section className="panel-region">
          <span className="section-label">Events</span>
          <div className="ruled">
            {graph.events.map((event) => (
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

        <section className="panel-region">
          <span className="section-label">Nodes</span>
          <div className="ruled">
            {graph.tasks.map((task) => (
              <div key={task.name} className="entity-card entity-card--node">
                <div className="row row--between">
                  <span className="row">
                    <span className="badge--node">{task.kind}</span>
                    <span className="mono" style={{ fontWeight: 500 }}>
                      {task.name}
                    </span>
                  </span>
                  <span className="section-label">
                    {NODE_KINDS[task.kind].label} · {task.mode}
                  </span>
                </div>
                {task.schedule ? (
                  <span className="row">
                    <ScheduleChip cron={task.schedule.cron} />
                    <span className="section-label">
                      {task.schedule.tz}
                      {task.schedule.enabled ? "" : " · disabled"}
                    </span>
                  </span>
                ) : null}
                <div className="chip-row">
                  {task.consumes.map((t) => (
                    <EventChip key={`c-${t}`} type={t} />
                  ))}
                  {task.consumes.length > 0 && task.emits.length > 0 ? (
                    <span className="muted">→</span>
                  ) : null}
                  {task.emits.map((t) => (
                    <EventChip key={`e-${t}`} type={t} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

"use client";

import type { CompileEntry, GraphEvent } from "@tabductor/engine";
import { schemaFields } from "../lib/schema-fields.js";
import type { EditorState, EditorStore } from "./editor-store.js";
import { SectionLabel, Stamp, VisibilityStamp } from "./primitives.js";

/**
 * The Events panel (component-specs §3.1): one ruled section per event entity. The
 * description is the only schema-shaped thing the author writes; the compiled schema
 * renders as a read-only field list, never JSON.
 *
 * No hooks (repo policy): panel state — the add input, delete confirms, the banner
 * deep-link flash — lives in the editor store's `ui` slice.
 */

export function EventPanel({ store, state }: { store: EditorStore; state: EditorState }) {
  return (
    <section className="panel-region">
      <SectionLabel>Events</SectionLabel>
      {state.graph.events.length === 0 ? (
        <p className="muted panel-empty">
          Events are the packets your nodes exchange. Describe the first one in prose — the
          description becomes its schema when you publish.
        </p>
      ) : (
        <div className="ruled">
          {state.graph.events.map((event) => (
            <EventCard key={event.type} event={event} store={store} state={state} />
          ))}
        </div>
      )}
      {state.ui.addingEvent ? (
        <input
          autoFocus
          placeholder="event.type"
          onBlur={(e) => {
            store.addEvent(e.target.value);
            store.setUi({ addingEvent: false });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              store.addEvent((e.target as HTMLInputElement).value);
              store.setUi({ addingEvent: false });
            }
            if (e.key === "Escape") store.setUi({ addingEvent: false });
          }}
        />
      ) : (
        <button onClick={() => store.setUi({ addingEvent: true })}>Add event</button>
      )}
    </section>
  );
}

function EventCard({
  event,
  store,
  state,
}: {
  event: GraphEvent;
  store: EditorStore;
  state: EditorState;
}) {
  const entry: CompileEntry | undefined = state.compileReport?.find((e) => e.type === event.type);
  const schema = state.eventSchemas[event.type];
  const flashing = state.ui.flash === event.type;
  const confirming =
    state.ui.confirmingDelete?.kind === "event" && state.ui.confirmingDelete.id === event.type;
  const referencedBy = state.graph.tasks.filter(
    (t) => t.emits.includes(event.type) || t.consumes.includes(event.type),
  );

  return (
    <div
      // Callback ref instead of an effect (hook policy): the banner deep link armed a
      // one-shot flash; scrolling here and consuming it keeps render pure.
      ref={(el) => {
        if (el && flashing) {
          el.scrollIntoView({ block: "nearest", behavior: "smooth" });
          store.consumeFlash();
        }
      }}
      className={`entity-card entity-card--event${flashing ? " row--fresh" : ""}`}
    >
      <div className="row row--between">
        <span className="mono entity-title" style={{ color: "var(--event-text)" }}>
          ◈ {event.type}
        </span>
        <span className="row">
          {event.public ? <VisibilityStamp isPublic /> : null}
          {entry ? <Stamp kind={entry.status === "failed" ? "compile_failed" : entry.status} /> : null}
        </span>
      </div>

      <label className="field">
        <span>Description</span>
        <textarea
          key={`${event.type}-description`}
          className="prose"
          rows={3}
          defaultValue={event.description}
          placeholder="A tweet found on the timeline: its text, author handle, permalink URL, and when it was posted."
          onBlur={(e) => store.patchEvent(event.type, { description: e.target.value })}
        />
      </label>
      {state.dirty && schema ? <span className="section-label">recompiles on publish</span> : null}

      <label className="row">
        <input
          type="checkbox"
          role="switch"
          aria-checked={event.public}
          checked={event.public}
          onChange={(e) => store.patchEvent(event.type, { public: e.target.checked })}
        />
        <span className="mono" style={{ fontSize: "var(--text-sm)" }}>
          Readable in share links
        </span>
      </label>

      <div>
        <SectionLabel>Schema · compiled from the description</SectionLabel>
        {schema ? (
          <SchemaRows schema={schema} />
        ) : (
          <p className="muted" style={{ fontSize: "var(--text-sm)", margin: "var(--space-1) 0 0" }}>
            No schema yet — it&apos;s compiled from the description when you publish.
          </p>
        )}
      </div>

      {entry?.status === "failed" ? (
        <p style={{ color: "var(--banner-error-text)", fontSize: "var(--text-sm)", margin: 0 }}>
          &ldquo;{entry.error}&rdquo; The schema comes from the prose — edit the description, then
          publish again.
        </p>
      ) : null}

      <div className="row" style={{ justifyContent: "flex-end" }}>
        {confirming ? (
          <span className="row" style={{ fontSize: "var(--text-sm)" }}>
            <span>
              Delete ◈ {event.type}?{" "}
              {referencedBy.length > 0
                ? `${referencedBy.map((t) => t.name).join(" and ")} reference it — their chips will be flagged until you rewire them. `
                : "No node references it. "}
              Its history stays in Runs and Events.
            </span>
            <button
              className="btn--destructive"
              onClick={() => {
                store.removeEvent(event.type);
                store.setUi({ confirmingDelete: null });
              }}
            >
              Delete event
            </button>
            <button className="btn--quiet" autoFocus onClick={() => store.setUi({ confirmingDelete: null })}>
              Keep
            </button>
          </span>
        ) : (
          <button
            className="btn--quiet"
            style={{ color: "var(--status-failed)" }}
            onClick={() => store.setUi({ confirmingDelete: { kind: "event", id: event.type } })}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

/** The no-raw-JSON law's display form (§2.12): ruled rows of name · type · detail. */
export function SchemaRows({ schema }: { schema: Record<string, unknown> }) {
  const fields = schemaFields(schema);
  if (fields.length === 0) {
    return (
      <p className="muted" style={{ fontSize: "var(--text-sm)", margin: "var(--space-1) 0 0" }}>
        Any object — the description didn&apos;t pin fields down.
      </p>
    );
  }
  return (
    <div className="schema-rows">
      {fields.map((f) => (
        <div key={f.name} className={`schema-row${f.name.includes(".") ? " schema-row--nested" : ""}`}>
          <span className="mono" style={{ fontWeight: 500 }}>
            {f.name.includes(".") ? f.name.split(".").pop() : f.name}
            {f.required ? "*" : ""}
          </span>
          <span className="mono muted">{f.type}</span>
          <span className="mono muted schema-detail">{f.detail ?? ""}</span>
        </div>
      ))}
      {fields.some((f) => f.required) ? <span className="section-label">* required</span> : null}
    </div>
  );
}

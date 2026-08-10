"use client";

import type { GraphTask, NodeKind } from "@tabductor/engine";
import { NODE_KINDS, KIND_LIST } from "../lib/node-kinds.js";
import type { EditorState, EditorStore } from "./editor-store.js";
import { JsonField } from "./json-field.js";
import { StubPanel } from "./stub-panel.js";

export type TaskConfigProps = {
  task: GraphTask;
  /** The published row's id, or null for a node that has not been saved yet. */
  taskId: string | null;
  store: EditorStore;
  state: EditorState;
};

/**
 * The node inspector. Every field writes straight into the editor's graph document; nothing
 * is validated here beyond "is this JSON" — `publishVersion` is the validator, and its
 * verdict is what the editor renders.
 */
export function TaskConfigPanel({ task, taskId, store, state }: TaskConfigProps) {
  const kind = NODE_KINDS[task.kind];
  const fail = (message: string): void => store.setState({ error: { message, details: {} } });
  // `limits.stub` gets its own editor (the StubExecutor panel), so it is held out of the
  // general limits field — two textareas over the same key would fight on blur.
  const { stub, ...limits } = task.limits as { stub?: unknown } & Record<string, unknown>;

  return (
    <div className="inspector">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>{task.name}</h2>
        <button onClick={() => store.removeNode(task.name)}>Delete node</button>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        {kind.hint}
      </p>

      <label className="field">
        <span>Name</span>
        <input
          key={`${task.name}-name`}
          defaultValue={task.name}
          onBlur={(e) => store.renameNode(task.name, e.target.value)}
        />
      </label>

      <div className="row">
        <label className="field" style={{ flex: 1 }}>
          <span>Kind</span>
          <select
            value={task.kind}
            onChange={(e) => store.patchNode(task.name, { kind: e.target.value as NodeKind })}
          >
            {KIND_LIST.map((k) => (
              <option key={k} value={k}>
                {NODE_KINDS[k].label}
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ flex: 1 }}>
          <span>Mode</span>
          <input
            key={`${task.name}-mode`}
            defaultValue={task.mode}
            onBlur={(e) => store.patchNode(task.name, { mode: e.target.value.trim() || "stub" })}
          />
        </label>
      </div>

      <label className="field">
        <span>Prompt</span>
        <textarea
          key={`${task.name}-prompt`}
          rows={3}
          defaultValue={task.prompt ?? ""}
          onBlur={(e) => store.patchNode(task.name, { prompt: e.target.value || null })}
        />
      </label>

      <JsonField
        label="Limits (run_timeout_ms, retry)"
        value={limits}
        rows={4}
        resetKey={`${task.name}-limits`}
        onParsed={(value) =>
          store.patchNode(task.name, { limits: stub === undefined ? value : { ...value, stub } })
        }
        onError={fail}
      />

      {task.mode === "stub" ? (
        <StubPanel task={task} taskId={taskId} store={store} state={state} />
      ) : null}

      <Emits task={task} store={store} onError={fail} />
      {kind.schedulable ? <ScheduleForm task={task} store={store} /> : null}
    </div>
  );
}

function Emits({
  task,
  store,
  onError,
}: {
  task: GraphTask;
  store: EditorStore;
  onError: (message: string) => void;
}) {
  const setEmits = (emits: GraphTask["emits"]): void => store.patchNode(task.name, { emits });

  return (
    <section>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>Emitted events</h3>
        <button
          onClick={() =>
            // `public: false` is spelled out rather than left to the zod default, because
            // this is the one place a new emit is born in the editor (S2d).
            setEmits([...task.emits, { type: "", packetSchema: { type: "object" }, public: false }])
          }
        >
          Add
        </button>
      </div>
      {task.emits.length === 0 ? (
        <p className="muted">
          None declared. A run may only emit event types listed here — the packet is checked
          against the schema before it is published.
        </p>
      ) : null}
      {task.emits.map((emit, i) => (
        <div className="emit" key={`${task.name}-emit-${i}`}>
          <div className="row">
            <input
              key={`${task.name}-emit-type-${i}`}
              placeholder="event.type"
              defaultValue={emit.type}
              onBlur={(e) =>
                setEmits(task.emits.map((x, j) => (i === j ? { ...x, type: e.target.value.trim() } : x)))
              }
            />
            <button onClick={() => setEmits(task.emits.filter((_, j) => j !== i))}>×</button>
          </div>
          <JsonField
            label="Packet schema (JSON Schema)"
            value={emit.packetSchema}
            rows={4}
            resetKey={`${task.name}-emit-schema-${i}`}
            onParsed={(packetSchema) =>
              setEmits(task.emits.map((x, j) => (i === j ? { ...x, packetSchema } : x)))
            }
            onError={onError}
          />
        </div>
      ))}
    </section>
  );
}

const DEFAULT_SCHEDULE = {
  cron: "*/5 * * * *",
  tz: "UTC",
  missedPolicy: "skip",
  overlapPolicy: "skip",
  maxQueueDepth: 1,
  enabled: true,
} as const;

/** §7's whole surface: cron, tz, and what to do about fires that were missed or overlap. */
function ScheduleForm({ task, store }: { task: GraphTask; store: EditorStore }) {
  const schedule = task.schedule;
  const patch = (next: Partial<NonNullable<GraphTask["schedule"]>>): void =>
    schedule ? store.patchNode(task.name, { schedule: { ...schedule, ...next } }) : undefined;

  return (
    <section>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>Schedule</h3>
        <button
          onClick={() => store.patchNode(task.name, { schedule: schedule ? null : { ...DEFAULT_SCHEDULE } })}
        >
          {schedule ? "Remove" : "Add"}
        </button>
      </div>
      {!schedule ? (
        <p className="muted">Unscheduled — this node runs when an event reaches it.</p>
      ) : (
        <>
          <div className="row">
            <label className="field" style={{ flex: 2 }}>
              <span>Cron</span>
              <input
                key={`${task.name}-cron`}
                defaultValue={schedule.cron}
                onBlur={(e) => patch({ cron: e.target.value.trim() })}
              />
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>Timezone</span>
              <input
                key={`${task.name}-tz`}
                defaultValue={schedule.tz}
                onBlur={(e) => patch({ tz: e.target.value.trim() || "UTC" })}
              />
            </label>
          </div>
          <div className="row">
            <label className="field" style={{ flex: 1 }}>
              <span>Missed fires</span>
              <select
                value={schedule.missedPolicy}
                onChange={(e) => patch({ missedPolicy: e.target.value as "skip" | "fire_once_catchup" })}
              >
                <option value="skip">skip</option>
                <option value="fire_once_catchup">fire once (catch up)</option>
              </select>
            </label>
            <label className="field" style={{ flex: 1 }}>
              <span>Overlap</span>
              <select
                value={schedule.overlapPolicy}
                onChange={(e) => patch({ overlapPolicy: e.target.value as "skip" | "queue" })}
              >
                <option value="skip">skip</option>
                <option value="queue">queue</option>
              </select>
            </label>
            <label className="field" style={{ width: 110 }}>
              <span>Queue depth</span>
              <input
                type="number"
                min={1}
                max={100}
                value={schedule.maxQueueDepth}
                onChange={(e) => patch({ maxQueueDepth: Number(e.target.value) || 1 })}
              />
            </label>
          </div>
          <label className="row" style={{ gap: 6 }}>
            <input
              type="checkbox"
              checked={schedule.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
            <span>enabled</span>
          </label>
        </>
      )}
    </section>
  );
}

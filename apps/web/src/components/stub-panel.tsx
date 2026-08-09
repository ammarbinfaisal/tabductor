"use client";

import type { GraphTask } from "@tabductor/engine";
import type { EditorState, EditorStore } from "./editor-store.js";
import { JsonField } from "./json-field.js";

/**
 * The StubExecutor scripting panel (U0): the scripted behaviour the stub reads out of
 * `limits_json.stub`, plus the button that starts a run right now.
 *
 * This is how a graph is exercised before a browser exists — emit these events after these
 * delays, fail, fail the first N attempts, or hang past the timeout.
 */
const EXAMPLE = {
  emits: [{ type: "tweet.detected", packet: { url: "https://example.test/1" }, delay_ms: 0 }],
} as const;

export function StubPanel({
  task,
  taskId,
  store,
  state,
}: {
  task: GraphTask;
  taskId: string | null;
  store: EditorStore;
  state: EditorState;
}) {
  const stub = (task.limits as { stub?: unknown }).stub;
  const firstEmit = task.emits[0]?.type ?? "manual.trigger";

  return (
    <section>
      <h3>Stub script</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        <code>emits</code>, <code>fail</code>, <code>fail_times</code>, <code>permanent_fail</code>,{" "}
        <code>hang_ms</code> — read from <code>limits_json.stub</code>.
      </p>
      <JsonField
        label="Behaviour"
        value={stub ?? EXAMPLE}
        rows={7}
        resetKey={`${task.name}-stub`}
        onParsed={(value) => store.patchNode(task.name, { limits: { ...task.limits, stub: value } })}
        onError={(message) => store.setState({ error: { message, details: {} } })}
      />

      <div className="row">
        <button
          disabled={!taskId || state.busy || state.dirty}
          onClick={() => void store.triggerNow(task.name, firstEmit)}
          title={
            !taskId
              ? "Publish the graph first — this node has no row to trigger yet"
              : state.dirty
                ? "Unsaved changes: publish before triggering"
                : `Publishes ${firstEmit} at this node`
          }
        >
          Trigger now
        </button>
        <span className="muted">
          {taskId ? (
            <>
              emits <code>{firstEmit}</code> at <code className="mono">{taskId}</code>
            </>
          ) : (
            "unsaved node"
          )}
        </span>
      </div>
    </section>
  );
}

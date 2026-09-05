"use client";

import type { GraphTask } from "@tabductor/engine";
import { KIND_LIST, MODE_REQUIREMENTS, NODE_KINDS, ROW_MODE_STATUS } from "../lib/node-kinds.js";
import type { EditorState, EditorStore } from "./editor-store.js";
import { EventChip, GhostChip, KindBadge, ScheduleChip, SectionLabel } from "./primitives.js";

/**
 * The Nodes panel (component-specs §3.2): one ruled section per node. Prompts are prose;
 * wiring is chips; limits are two numeric knobs. No JSON exists on this card — the stub
 * script editor died with the event-centric model (scriptless stubs derive their emits
 * from the compiled schemas).
 *
 * No hooks (repo policy): menu/confirm/note state lives in the editor store's `ui` slice.
 */

const DEFAULT_SCHEDULE = {
  cron: "*/5 * * * *",
  tz: "UTC",
  missedPolicy: "skip",
  overlapPolicy: "skip",
  maxQueueDepth: 1,
  enabled: true,
} as const;

export function NodePanel({ store, state }: { store: EditorStore; state: EditorState }) {
  return (
    <section className="panel-region">
      <SectionLabel>Nodes</SectionLabel>
      {state.graph.tasks.length === 0 ? (
        <p className="muted panel-empty">
          Nodes do the work. Add one, tell it what to do in its prompt, then choose which events it
          consumes and emits.
        </p>
      ) : (
        <div className="ruled">
          {state.graph.tasks.map((task) => (
            <NodeCard key={task.name} task={task} store={store} state={state} />
          ))}
        </div>
      )}
      <div className="row">
        {KIND_LIST.map((kind) => (
          <button key={kind} title={NODE_KINDS[kind].hint} onClick={() => store.addNode(kind)}>
            Add {NODE_KINDS[kind].label.toLowerCase()} node
          </button>
        ))}
      </div>
    </section>
  );
}

function NodeCard({ task, store, state }: { task: GraphTask; store: EditorStore; state: EditorState }) {
  const kind = NODE_KINDS[task.kind];
  const declared = state.graph.events.map((e) => e.type);
  const confirming =
    state.ui.confirmingDelete?.kind === "node" && state.ui.confirmingDelete.id === task.name;
  const taskId = state.taskIds[task.name];
  const published = state.publishedTasks[task.name];
  const limits = task.limits as { run_timeout_ms?: unknown; retry?: { max?: unknown } };
  const timeoutS = typeof limits.run_timeout_ms === "number" ? limits.run_timeout_ms / 1000 : "";
  const retries = typeof limits.retry?.max === "number" ? limits.retry.max : "";
  const undeclaredEmit = task.emits.find((t) => !declared.includes(t));

  const patchLimits = (patch: Record<string, unknown>): void =>
    store.patchNode(task.name, { limits: { ...task.limits, ...patch } });

  const cardClass =
    task.kind === "decision" ? "entity-card entity-card--node entity-card--node-decision" : "entity-card entity-card--node";

  return (
    <div className={cardClass}>
      <div className="row">
        <KindBadge kind={task.kind} />
        <input
          key={`${task.name}-name`}
          className="entity-name-input mono"
          defaultValue={task.name}
          aria-label="Node name"
          onBlur={(e) => store.renameNode(task.name, e.target.value)}
        />
      </div>

      <label className="field">
        <span>Prompt</span>
        <textarea
          key={`${task.name}-prompt`}
          className="prose"
          rows={3}
          defaultValue={task.prompt ?? ""}
          placeholder="Open the timeline, find new tweets, and emit one tweet.detected per new tweet."
          onBlur={(e) => store.patchNode(task.name, { prompt: e.target.value || null })}
        />
      </label>

      <div>
        <SectionLabel>Triggers</SectionLabel>
        <div className="chip-row">
          {task.schedule ? (
            <ScheduleChip
              cron={task.schedule.cron}
              onRemove={() => store.patchNode(task.name, { schedule: null })}
            />
          ) : null}
          {task.consumes.map((type) => (
            <EventChip key={type} type={type} onRemove={() => store.toggleConsume(task.name, type)} />
          ))}
          <ChipAdder
            task={task.name}
            list="consumes"
            options={declared.filter((t) => !task.consumes.includes(t))}
            store={store}
            state={state}
            allowFree
          />
          {kind.schedulable && !task.schedule ? (
            <GhostChip
              label="+ cron"
              onClick={() => store.patchNode(task.name, { schedule: { ...DEFAULT_SCHEDULE } })}
            />
          ) : null}
        </div>
        {task.schedule ? (
          <div className="row" style={{ marginTop: "var(--space-2)" }}>
            <label className="field">
              <span>Cron</span>
              <input
                key={`${task.name}-cron`}
                style={{ width: 160 }}
                defaultValue={task.schedule.cron}
                onBlur={(e) =>
                  store.patchNode(task.name, {
                    schedule: { ...task.schedule!, cron: e.target.value.trim() || task.schedule!.cron },
                  })
                }
              />
            </label>
            <label className="field">
              <span>Timezone</span>
              <input
                key={`${task.name}-tz`}
                style={{ width: 120 }}
                defaultValue={task.schedule.tz}
                onBlur={(e) =>
                  store.patchNode(task.name, {
                    schedule: { ...task.schedule!, tz: e.target.value.trim() || "UTC" },
                  })
                }
              />
            </label>
          </div>
        ) : null}
      </div>

      <div>
        <SectionLabel>Emits</SectionLabel>
        <div className="chip-row">
          {task.emits.map((type) => (
            <EventChip
              key={type}
              type={type}
              invalid={!declared.includes(type)}
              onRemove={() => store.toggleEmit(task.name, type)}
            />
          ))}
          <ChipAdder
            task={task.name}
            list="emits"
            options={declared.filter((t) => !task.emits.includes(t))}
            store={store}
            state={state}
          />
        </div>
        {undeclaredEmit ? (
          <p style={{ color: "var(--banner-error-text)", fontSize: "var(--text-sm)", margin: "var(--space-1) 0 0" }}>
            &lsquo;{undeclaredEmit}&rsquo; isn&apos;t a declared event. Describe it in Events, or
            pick one from the list.
          </p>
        ) : null}
      </div>

      <div className="row">
        <label className="field">
          <span>Mode</span>
          <select value={task.mode} onChange={(e) => store.setMode(task.name, e.target.value)}>
            {[...new Set([...kind.modes, task.mode])].map((m) => {
              const unavailable = state.engineExecutors !== null && !state.engineExecutors.includes(`${task.kind}:${m}`);
              return (
                <option key={m} value={m} disabled={unavailable && m !== task.mode} title={unavailable ? MODE_REQUIREMENTS[m] : undefined}>
                  {m}
                  {unavailable ? " (engine: not available)" : ""}
                </option>
              );
            })}
          </select>
        </label>
        <label className="field">
          <span>Timeout</span>
          <span className="row" style={{ gap: "var(--space-1)" }}>
            <input
              key={`${task.name}-timeout`}
              type="number"
              inputMode="numeric"
              min={1}
              style={{ width: 88, textAlign: "right" }}
              defaultValue={timeoutS}
              onBlur={(e) => {
                const s = Number(e.target.value);
                patchLimits({ run_timeout_ms: s > 0 ? s * 1000 : undefined });
              }}
            />
            <span className="section-label">s</span>
          </span>
        </label>
        <label className="field">
          <span>Retries</span>
          <span className="row" style={{ gap: "var(--space-1)" }}>
            <input
              key={`${task.name}-retries`}
              type="number"
              inputMode="numeric"
              min={0}
              style={{ width: 88, textAlign: "right" }}
              defaultValue={retries}
              onBlur={(e) => {
                const max = Number(e.target.value);
                patchLimits({ retry: max > 0 ? { ...(task.limits.retry as object), max } : undefined });
              }}
            />
            <span className="section-label">tries</span>
          </span>
        </label>
      </div>

      <p className="muted" style={{ fontSize: "var(--text-sm)", margin: "var(--space-1) 0 0" }}>
        {task.mode === "stub"
          ? "Stub: emits one valid sample of each declared event, or runs its scripted stub. For testing the graph's wiring."
          : kind.execution}
        {task.kind === "asset" && task.mode === "ai" && state.engineCapabilities !== null && !state.engineCapabilities.includes("python.run")
          ? " (python.run: the engine has no PYRUNNER_URL, so it will report itself unavailable.)"
          : ""}
      </p>
      {published && published.mode !== task.mode ? (
        <p className="muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>
          Published row is <code>{published.mode}</code>: {ROW_MODE_STATUS[published.mode] ?? published.mode}
        </p>
      ) : null}
      {published?.compiledPrompt ? (
        <details>
          <summary className="section-label" style={{ cursor: "pointer" }}>
            Internal prompt (compiled at publish, read-only)
          </summary>
          <pre className="mono" style={{ whiteSpace: "pre-wrap", fontSize: "var(--text-sm)", maxHeight: 320, overflow: "auto" }}>
            {published.compiledPrompt}
          </pre>
        </details>
      ) : null}

      <div className="row row--between">
        <span className="row">
          <button
            disabled={!taskId || state.busy || state.dirty}
            title={
              !taskId
                ? "Publish first — this node has no published row to trigger yet"
                : state.dirty
                  ? "Unpublished edits: publish before triggering"
                  : "Queues a run of this node"
            }
            onClick={() => void store.triggerNow(task.name)}
          >
            Trigger now
          </button>
          {state.ui.triggeredNote === task.name ? (
            <span className="section-label">Run queued · view in Runs</span>
          ) : null}
        </span>
        {confirming ? (
          <span className="row" style={{ fontSize: "var(--text-sm)" }}>
            <span>
              Delete {task.name}? Nothing will emit its events after your next publish. Past runs
              and packets stay in history.
            </span>
            <button
              className="btn--destructive"
              onClick={() => {
                store.removeNode(task.name);
                store.setUi({ confirmingDelete: null });
              }}
            >
              Delete node
            </button>
            <button className="btn--quiet" autoFocus onClick={() => store.setUi({ confirmingDelete: null })}>
              Keep
            </button>
          </span>
        ) : (
          <button
            className="btn--quiet"
            style={{ color: "var(--status-failed)" }}
            onClick={() => store.setUi({ confirmingDelete: { kind: "node", id: task.name } })}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The ghost add chip + its recognition-over-recall menu: every declared event, plus the
 * "declare new" path that creates the entity in the Events panel. Open/typed state lives
 * in the store's `ui` slice (hook policy).
 */
function ChipAdder({
  task,
  list,
  options,
  store,
  state,
  allowFree,
}: {
  task: string;
  list: "emits" | "consumes";
  options: string[];
  store: EditorStore;
  state: EditorState;
  /** Triggers may name external types (system events, manual triggers) with no entity. */
  allowFree?: boolean;
}) {
  const open = state.ui.chipMenu?.task === task && state.ui.chipMenu.list === list;
  if (!open) {
    return (
      <GhostChip label="+ event" onClick={() => store.setUi({ chipMenu: { task, list }, chipMenuText: "" })} />
    );
  }

  const text = state.ui.chipMenuText;
  const matches = options.filter((o) => o.includes(text.trim()));
  const toggle = list === "emits" ? store.toggleEmit : store.toggleConsume;
  const close = (): void => store.setUi({ chipMenu: null, chipMenuText: "" });
  const pick = (type: string): void => {
    toggle(task, type);
    close();
  };
  const declare = (type: string): void => {
    store.addEvent(type);
    toggle(task, type);
    close();
  };

  return (
    <span className="chip-menu">
      <input
        autoFocus
        placeholder="event.type"
        value={text}
        onChange={(e) => store.setUi({ chipMenuText: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
          if (e.key === "Enter" && text.trim()) {
            const t = text.trim();
            if (options.includes(t) || allowFree) pick(t);
            else declare(t);
          }
        }}
      />
      <div className="chip-menu-options">
        {matches.map((o) => (
          <button key={o} className="btn--quiet" onClick={() => pick(o)}>
            ◈ {o}
          </button>
        ))}
        {text.trim() && !options.includes(text.trim()) ? (
          <button className="btn--quiet" onClick={() => declare(text.trim())}>
            Declare new event &ldquo;{text.trim()}&rdquo;…
          </button>
        ) : null}
      </div>
    </span>
  );
}

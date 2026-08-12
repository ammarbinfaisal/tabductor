"use client";

import type { ReactNode } from "react";

/**
 * The Ruled Ink atoms (component-specs §2): stamps, chips, badges. Presentation only —
 * every color is a DESIGN.md token via the classes in globals.css, and the redundancy law
 * holds here (◈ on events, the kind word on nodes, fixed vocabulary inside stamp form)
 * so no caller can accidentally make color the only cue.
 */

const STAMP_VARS: Record<string, string> = {
  queued: "var(--status-queued)",
  running: "var(--status-running)",
  succeeded: "var(--status-succeeded)",
  failed: "var(--status-failed)",
  timed_out: "var(--status-timed-out)",
  cancelled: "var(--status-cancelled)",
  generated: "var(--compile-generated)",
  reused: "var(--compile-reused)",
  compile_failed: "var(--compile-failed)",
  loop: "var(--map-annotation)",
  revoked: "var(--status-cancelled)",
};

const STAMP_LABELS: Record<string, string> = {
  timed_out: "TIMED OUT",
  compile_failed: "FAILED",
};

export function Stamp({ kind, landing }: { kind: string; landing?: boolean }) {
  const color = STAMP_VARS[kind] ?? "var(--status-queued)";
  const label = STAMP_LABELS[kind] ?? kind.toUpperCase();
  const classes = [
    "stamp",
    kind === "cancelled" || kind === "revoked" ? "stamp--cancelled" : "",
    kind === "compile_failed" ? "stamp--failed-tilt" : "",
    landing ? "stamp--landing" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes} style={{ color }} role="status">
      {kind === "running" ? <span className="pulse-dot" aria-hidden /> : null}
      {label}
    </span>
  );
}

/** The one filled stamp (PUBLIC) and its dashed twin (PRIVATE) — visibility is scope, not valence. */
export function VisibilityStamp({ isPublic }: { isPublic: boolean }) {
  return isPublic ? (
    <span
      className="stamp"
      style={{ color: "var(--visibility-public-text)", background: "var(--visibility-public-bg)" }}
    >
      ◈ PUBLIC
    </span>
  ) : (
    <span
      className="stamp"
      style={{ color: "var(--visibility-private-text)", borderStyle: "dashed" }}
    >
      <LockGlyph /> PRIVATE
    </span>
  );
}

/**
 * Endpoint health (U1.5). Deliberately not `Stamp` with a `healthy`/`unhealthy` kind: those
 * are run *outcomes*, and reusing that vocabulary for live infrastructure state would blur
 * "this task succeeded" with "this endpoint is up" — two different questions. The color
 * pair is the entity-family ink (ink-blue calm / amber draws-the-eye), same tokens
 * `chip--event`/`badge--node` use, not the status ramp.
 */
export function HealthStamp({ healthy }: { healthy: boolean }) {
  return (
    <span className="stamp" style={{ color: healthy ? "var(--event-text)" : "var(--node-text)" }} role="status">
      {healthy ? "HEALTHY" : "UNHEALTHY"}
    </span>
  );
}

function LockGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden style={{ marginRight: 2 }}>
      <rect x="1.5" y="4.5" width="7" height="4.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3 4.5 V3 a2 2 0 0 1 4 0 v1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function EventChip({
  type,
  invalid,
  onRemove,
}: {
  type: string;
  invalid?: boolean;
  onRemove?: () => void;
}) {
  return (
    <span
      className="chip chip--event"
      style={invalid ? { borderColor: "var(--chip-invalid-border)" } : undefined}
    >
      ◈ {type}
      {onRemove ? (
        <button className="chip-remove" aria-label={`Remove ◈ ${type}`} onClick={onRemove}>
          ×
        </button>
      ) : null}
    </span>
  );
}

/**
 * `decision` gets its own token-family class (`.badge--node-decision`, globals.css) —
 * `browser`/`asset` share `--node-*` (amber, "the machinery that acts"); `decision` is the
 * third family (`--decision-*`, aliased off `--warning-*`, argued in globals.css) because it
 * neither acts on a page nor writes the store — it plans. The kind word itself (the
 * redundancy law's non-color cue) is unchanged either way.
 */
export function KindBadge({ kind }: { kind: string }) {
  const classes = kind === "decision" ? "badge--node badge--node-decision" : "badge--node";
  return <span className={classes}>{kind}</span>;
}

export function ScheduleChip({ cron, onRemove }: { cron: string; onRemove?: () => void }) {
  return (
    <span className="chip chip--schedule">
      {cron}
      {onRemove ? (
        <button className="chip-remove" aria-label="Remove schedule" onClick={onRemove}>
          ×
        </button>
      ) : null}
    </span>
  );
}

/** The dashed add affordance ending every chip row (recognition over recall: it opens a menu). */
export function GhostChip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="chip chip--ghost" onClick={onClick}>
      {label}
    </button>
  );
}

/** Section label: the mono uppercase margin apparatus (`EVENTS`, `TRIGGERS`, `SCHEMA · …`). */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <span className="section-label">{children}</span>;
}

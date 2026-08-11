"use client";

import type { CompileEntry } from "@tabductor/engine";
import { Stamp } from "./primitives.js";

/**
 * The compile report (component-specs §3.4) — the stamp moment. A ruled section under the
 * header, one row per event, stamps landing staggered in event order: the product's one
 * indulgent animation. FAILED stamps land last and settle tilted.
 */
export function CompileReport({
  entries,
  versionId,
  failed,
  onDismiss,
}: {
  entries: CompileEntry[];
  versionId: string | null;
  failed: boolean;
  onDismiss: () => void;
}) {
  const generated = entries.filter((e) => e.status === "generated").length;
  const reused = entries.filter((e) => e.status === "reused").length;
  // FAILED stamps land last: order the stagger, not the rows.
  const order = new Map(
    [...entries].sort((a, b) => Number(a.status === "failed") - Number(b.status === "failed")).map((e, i) => [e.type, i]),
  );

  return (
    <section className="compile-report">
      <div className="row row--between">
        <span className="mono" style={{ fontWeight: 500, fontSize: "var(--text-sm)" }}>
          {failed ? "Compile report · publish failed" : `Compile report · ${versionId ?? ""} published`}
        </span>
        <button className="btn--quiet" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      <div className="ruled">
        {entries.map((entry) => (
          <div key={entry.type}>
            <div className="row row--between">
              <span className="mono" style={{ color: "var(--event-text)", fontSize: "var(--text-sm)" }}>
                ◈ {entry.type}
              </span>
              <span style={{ animationDelay: `${(order.get(entry.type) ?? 0) * 60}ms` }} className="stamp-slot">
                <Stamp kind={entry.status === "failed" ? "compile_failed" : entry.status} landing />
              </span>
            </div>
            {entry.status === "failed" && entry.error ? (
              <p style={{ color: "var(--banner-error-text)", fontSize: "var(--text-sm)", margin: "var(--space-1) 0 0" }}>
                &ldquo;{entry.error}&rdquo;
              </p>
            ) : null}
          </div>
        ))}
      </div>
      <p className="muted" style={{ fontSize: "var(--text-sm)", marginBottom: 0 }}>
        {failed
          ? "Nothing was published — the live version is unchanged. Fix the failed description and publish again."
          : `${entries.length} event${entries.length === 1 ? "" : "s"} · ${generated} generated · ${reused} reused. Schemas updated on the event cards.`}
      </p>
    </section>
  );
}

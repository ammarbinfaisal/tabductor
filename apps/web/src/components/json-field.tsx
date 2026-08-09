"use client";

import type { ReactNode } from "react";

/**
 * A JSON textarea that parses on blur.
 *
 * Uncontrolled on purpose: half-typed JSON is not a value the store should hold, and the
 * hook policy leaves no component-local place to park it. `resetKey` goes on React's `key`
 * so switching nodes reseeds the field instead of showing the previous node's text.
 */
export function JsonField(props: {
  label: ReactNode;
  value: unknown;
  resetKey: string;
  rows?: number;
  placeholder?: string;
  onParsed: (value: Record<string, unknown>) => void;
  onError: (message: string) => void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <textarea
        key={props.resetKey}
        rows={props.rows ?? 6}
        spellCheck={false}
        placeholder={props.placeholder}
        defaultValue={JSON.stringify(props.value ?? {}, null, 2)}
        onBlur={(e) => {
          const text = e.target.value.trim();
          if (text === "") return props.onParsed({});
          try {
            const parsed: unknown = JSON.parse(text);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
              return props.onError(`${String(props.label)} must be a JSON object`);
            }
            props.onParsed(parsed as Record<string, unknown>);
          } catch (err) {
            props.onError(`${String(props.label)}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }}
      />
    </label>
  );
}

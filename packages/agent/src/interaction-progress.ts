import { createHash } from "node:crypto";

export type Interaction = { operation: string; tool: string; state: string };
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Compare page content and editable state, independently of anchor names and paging. */
export function interactionState(observed: unknown): string {
  const p = observed && typeof observed === "object" ? observed as Record<string, unknown> : {};
  const elements = Array.isArray(p.elements) ? p.elements as Record<string, unknown>[] : [];
  return digest({ url: p.url, text: p.text, fields: elements.filter(e => e.focused === true)
    .map(e => ({ role: e.role, name: e.name, value: e.value, checked: e.checked, selected: e.selected })) });
}

/** Small history of mutations only: reads cannot hide an alternating action cycle. */
export function interactionProgress() {
  let history: Interaction[] = [];
  let rejections = 0;
  return {
    restore(value: unknown) {
      if (!Array.isArray(value)) return;
      history = value.filter((v): v is Interaction => v !== null && typeof v === "object" &&
        typeof v.operation === "string" && /^[a-f0-9]{64}$/.test(v.operation) &&
        typeof v.state === "string" && /^[a-f0-9]{64}$/.test(v.state) && typeof v.tool === "string").slice(-24);
    },
    record(operation: string, tool: string, observed: unknown) {
      history = [...history, { operation: digest(operation), tool, state: interactionState(observed) }].slice(-24);
    },
    check(operation: string): { tools: string[]; exhausted: boolean; rejectedAttempts: number } | null {
      for (let size = 2; size <= 6; size++) {
        if (history.length < size * 3) continue;
        const tail = history.slice(-size * 3);
        if (tail[0]!.operation !== digest(operation)) continue;
        if (tail.every((item, index) => item.operation === tail[index % size]!.operation && item.state === tail[index % size]!.state)) {
          return { tools: tail.slice(0, size).map(item => item.tool), exhausted: ++rejections >= 3, rejectedAttempts: rejections };
        }
      }
      return null;
    },
    acknowledge() { history = []; rejections = 0; },
    snapshot: () => history,
  };
}

"use client";

import type { NodeKind } from "@tabductor/engine";

/**
 * The palette, as data (U0/U1): adding a node kind is adding a row here, never an
 * `if (kind === ...)` in a component. S5g's `decision` kind lands as one more entry.
 *
 * `schedulable` is the §7 rule the editor renders and the API enforces: `asset` nodes are
 * event-triggered only, so their card offers no `+ cron` chip and a save that smuggles one
 * in comes back as a typed error on the node.
 */
export type NodeKindSpec = {
  label: string;
  /** One line, shown on the add button and in the map's tooltip vocabulary. */
  hint: string;
  schedulable: boolean;
  /**
   * The modes an author may *choose*. Two, and only two, for every kind that has a stub:
   * `stub` (the permanent graph-testing mode, always first and the safe default) and `ai`
   * (the real one). What happens *inside* `ai` is the engine's business and is shown as
   * status, not offered as a choice — a browser node compiles itself to a static script
   * after its first clean run and falls back to the agent when the page changes; an asset
   * node always has `python.run` beside its other tools. `checkGraph` rejects `compiled` and
   * `python` in a document, so this list is not merely a UI convention.
   */
  modes: readonly string[];
  /** What a new node of this kind starts as. `decision` has no stub executor, so it is `ai`. */
  defaultMode: string;
  /** What `ai` means for this kind — the line under the Mode selector. */
  execution: string;
};

export const NODE_KINDS: Record<NodeKind, NodeKindSpec> = {
  browser: {
    label: "Browser",
    hint: "page.* · network.* · emit — drives your own logged-in browser",
    schedulable: true,
    modes: ["stub", "ai"],
    defaultMode: "stub",
    execution:
      "Runs as an agent first. After the first clean run the engine compiles the trace into a static script and runs that with no model calls; if the page changes the script hands the run back to the agent, which recompiles.",
  },
  asset: {
    label: "Asset",
    hint: "mcp.* · assets.* · store.* · python.run · emit — event-triggered only",
    schedulable: false,
    modes: ["stub", "ai"],
    defaultMode: "stub",
    execution:
      "Runs as an agent with the asset store, the workflow store, every configured MCP server and python.run — it writes and runs Python itself when a job calls for it.",
  },
  decision: {
    label: "Decision",
    hint: "store.query · emit — the smallest registry in the system",
    schedulable: true,
    modes: ["ai"],
    defaultMode: "ai",
    execution: "Reads the workflow store and the trigger, and decides what to emit.",
  },
};

export const KIND_LIST = Object.keys(NODE_KINDS) as NodeKind[];

/** Why a mode the engine did not register is disabled — the boot gate it is behind. */
export const MODE_REQUIREMENTS: Record<string, string> = {
  ai: "needs ANTHROPIC_API_KEY or OPENAI_API_KEY on the engine",
};

/** How a published row's engine-assigned mode reads on the card. */
export const ROW_MODE_STATUS: Record<string, string> = {
  compiled: "fast path active — compiled script, no model calls until its guards fail",
  ai: "agent",
  stub: "stub",
};

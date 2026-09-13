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
  /** Execution is automatic; the editor authors every kind as `ai`. */
  execution: string;
};

export const NODE_KINDS: Record<NodeKind, NodeKindSpec> = {
  browser: {
    label: "Browser",
    hint: "page.* · network.* · emit — drives your own logged-in browser",
    schedulable: true,
    execution:
      "Runs as an agent first. After the first clean run the engine compiles the trace into a static script and runs that with no model calls; if the page changes the script hands the run back to the agent, which recompiles.",
  },
  asset: {
    label: "Asset",
    hint: "mcp.* · assets.* · store.* · python.run · emit — event-triggered only",
    schedulable: false,
    execution:
      "Runs as an agent with the asset store, the workflow store, every configured MCP server and python.run — it writes and runs Python itself when a job calls for it.",
  },
  decision: {
    label: "Decision",
    hint: "store.query · emit — the smallest registry in the system",
    schedulable: true,
    execution: "Reads the workflow store and the trigger, and decides what to emit.",
  },
};

export const KIND_LIST = Object.keys(NODE_KINDS) as NodeKind[];

/** How a published row's engine-assigned mode reads on the card. */
export const ROW_MODE_STATUS: Record<string, string> = {
  compiled: "fast path active — compiled script, no model calls until its guards fail",
  ai: "agent",
};

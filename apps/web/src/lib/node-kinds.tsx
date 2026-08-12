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
};

export const NODE_KINDS: Record<NodeKind, NodeKindSpec> = {
  browser: {
    label: "Browser",
    hint: "page.* · network.* · emit",
    schedulable: true,
  },
  asset: {
    label: "Asset",
    hint: "mcp.* · assets.* · store.query/insert/upsert · emit — event-triggered only",
    schedulable: false,
  },
  decision: {
    label: "Decision",
    hint: "store.query · emit — the smallest registry in the system",
    schedulable: true,
  },
};

export const KIND_LIST = Object.keys(NODE_KINDS) as NodeKind[];

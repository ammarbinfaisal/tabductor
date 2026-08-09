"use client";

import type { ComponentType } from "react";
import type { NodeKind } from "@tabductor/engine";
import { TaskConfigPanel, type TaskConfigProps } from "../components/task-config-panel.js";

/**
 * The palette, as data (U0): adding a node kind is adding a row here, never an
 * `if (kind === ...)` in a component. S5g's `decision` kind and its store-only config panel
 * land as one more entry.
 *
 * `schedulable` is the §7 rule the editor renders and the API enforces: `asset` nodes are
 * event-triggered only, so their panel has no schedule form and a save that smuggles one in
 * comes back as a typed error on the node.
 */
export type NodeKindSpec = {
  label: string;
  /** One line, shown on the palette button and under the node's name. */
  hint: string;
  schedulable: boolean;
  configPanel: ComponentType<TaskConfigProps>;
};

export const NODE_KINDS: Record<NodeKind, NodeKindSpec> = {
  browser: {
    label: "Browser",
    hint: "page.* · network.* · emit",
    schedulable: true,
    configPanel: TaskConfigPanel,
  },
  asset: {
    label: "Asset",
    hint: "mcp.* · assets.* · emit — event-triggered only",
    schedulable: false,
    configPanel: TaskConfigPanel,
  },
};

export const KIND_LIST = Object.keys(NODE_KINDS) as NodeKind[];

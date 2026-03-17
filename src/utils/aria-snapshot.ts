import {
  BrowserSnapshotNode,
  BrowserSnapshotResponse,
  SnapshotMode,
} from "@/protocol/messages";
import { Context } from "@/context";
import { ToolResult } from "@/tools/tool";

type SnapshotProperties = Record<string, unknown>;

export type ActionablePreview = {
  ref: string;
  nodeId: string;
  role?: string;
  name?: string;
  value?: string;
  href?: string;
  placeholder?: string;
  actions: string[];
  disabled: boolean;
  inViewport: boolean;
  landmark?: string;
  heading?: string;
  form?: string;
  section?: string;
};

export type TextSearchMatch = {
  nodeId: string;
  ref?: string;
  role?: string;
  name?: string;
  value?: string;
  href?: string;
  actions: string[];
  matchContext: string;
};

export type ActionableGroup = {
  nodeId: string;
  role?: string;
  name?: string;
  landmark?: string;
  heading?: string;
  form?: string;
  section?: string;
  inViewport: boolean;
  itemCount: number;
  actionables: ActionablePreview[];
};

export type ContextAnchorPreview = {
  nodeId: string;
  role?: string;
  name?: string;
  landmark?: string;
  heading?: string;
  form?: string;
  section?: string;
};

export type DiscoveryStats = {
  actionableCount: number;
  actionableGroups: number;
  inViewportCount: number;
  visibleGroups: number;
  contextAnchors: number;
  roleCounts: string;
};

export type PageDiscoveryState = {
  pageVersion: number;
  page: BrowserSnapshotResponse["page"];
  actionables: ActionablePreview[];
  groups: ActionableGroup[];
  contextAnchors: ContextAnchorPreview[];
  stats: DiscoveryStats;
};

function flattenNodes(nodes: BrowserSnapshotNode[]): BrowserSnapshotNode[] {
  const flattened: BrowserSnapshotNode[] = [];
  const visit = (node: BrowserSnapshotNode) => {
    flattened.push(node);
    for (const child of node.children ?? []) {
      visit(child);
    }
  };

  for (const node of nodes) {
    visit(node);
  }

  return flattened;
}

function getProperties(node: BrowserSnapshotNode): SnapshotProperties {
  return (node.properties as SnapshotProperties | undefined) ?? {};
}

function getStringProperty(properties: SnapshotProperties, key: string): string {
  const value = properties[key];
  return typeof value === "string" ? value : "";
}

function getBooleanProperty(properties: SnapshotProperties, key: string): boolean {
  return properties[key] === true;
}

function getStringArrayProperty(
  properties: SnapshotProperties,
  key: string,
): string[] {
  const value = properties[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isActionableNode(node: BrowserSnapshotNode): boolean {
  return Boolean(node.ref);
}

function isGroupNode(node: BrowserSnapshotNode): boolean {
  return getStringProperty(getProperties(node), "kind") === "group";
}

function formatActionableLine(node: ActionablePreview): string {
  const parts = [node.ref, node.role ?? "unknown", node.name ?? "unnamed"];

  if (node.href) {
    parts.push(node.href);
  }
  if (node.value?.trim()) {
    parts.push(`value="${node.value.trim()}"`);
  }
  if (node.placeholder) {
    parts.push(`placeholder="${node.placeholder}"`);
  }
  if (node.inViewport) {
    parts.push("in-viewport");
  }
  if (node.disabled) {
    parts.push("disabled");
  }

  return `- ${parts.join(" | ")}`;
}

function formatContextSummary(
  value: Pick<ActionablePreview, "landmark" | "heading" | "form" | "section">,
): string | null {
  const context = [value.landmark, value.heading, value.form, value.section].filter(
    Boolean,
  );
  return context.length ? context.join(" / ") : null;
}

function toActionablePreview(node: BrowserSnapshotNode): ActionablePreview {
  const properties = getProperties(node);
  return {
    ref: node.ref!,
    nodeId: node.nodeId,
    role: node.role,
    name: node.name,
    value: node.value,
    href: getStringProperty(properties, "href") || undefined,
    placeholder: getStringProperty(properties, "placeholder") || undefined,
    actions: getStringArrayProperty(properties, "actions"),
    disabled: getBooleanProperty(properties, "disabled"),
    inViewport: getBooleanProperty(properties, "inViewport"),
    landmark: getStringProperty(properties, "landmark") || undefined,
    heading: getStringProperty(properties, "heading") || undefined,
    form: getStringProperty(properties, "form") || undefined,
    section: getStringProperty(properties, "section") || undefined,
  } satisfies ActionablePreview;
}

export function extractActionablePreviews(
  snapshot: BrowserSnapshotResponse,
): ActionablePreview[] {
  const flattened = flattenNodes(snapshot.snapshot.root);
  return flattened.filter(isActionableNode).map(toActionablePreview);
}

function createGroupPreview(node: BrowserSnapshotNode): ActionableGroup {
  const properties = getProperties(node);
  return {
    nodeId: node.nodeId,
    role: node.role,
    name: node.name,
    landmark: getStringProperty(properties, "landmark") || undefined,
    heading: getStringProperty(properties, "heading") || undefined,
    form: getStringProperty(properties, "form") || undefined,
    section: getStringProperty(properties, "section") || undefined,
    inViewport: getBooleanProperty(properties, "inViewport"),
    itemCount: 0,
    actionables: [],
  };
}

export function extractActionableGroups(
  snapshot: BrowserSnapshotResponse,
): ActionableGroup[] {
  const groups: ActionableGroup[] = [];
  const groupsByNodeId = new Map<string, ActionableGroup>();
  let ungrouped: ActionableGroup | null = null;

  const ensureGroup = (node: BrowserSnapshotNode) => {
    let group = groupsByNodeId.get(node.nodeId);
    if (!group) {
      group = createGroupPreview(node);
      groupsByNodeId.set(node.nodeId, group);
      groups.push(group);
    }
    return group;
  };

  const ensureUngrouped = () => {
    if (ungrouped) {
      return ungrouped;
    }

    ungrouped = {
      nodeId: "ungrouped",
      role: "group",
      name: "Ungrouped",
      inViewport: false,
      itemCount: 0,
      actionables: [],
    };
    groups.push(ungrouped);
    return ungrouped;
  };

  const visit = (
    node: BrowserSnapshotNode,
    currentGroup: ActionableGroup | null,
  ) => {
    let nextGroup = currentGroup;
    if (isGroupNode(node)) {
      nextGroup = ensureGroup(node);
    } else if (isActionableNode(node)) {
      const targetGroup = nextGroup ?? ensureUngrouped();
      const preview = toActionablePreview(node);
      targetGroup.actionables.push(preview);
      targetGroup.itemCount = targetGroup.actionables.length;
      targetGroup.inViewport = targetGroup.inViewport || preview.inViewport;
    }

    for (const child of node.children ?? []) {
      visit(child, nextGroup);
    }
  };

  for (const root of snapshot.snapshot.root) {
    visit(root, null);
  }

  return groups.filter((group) => group.actionables.length > 0);
}

function extractContextAnchors(
  snapshot: BrowserSnapshotResponse,
): ContextAnchorPreview[] {
  return flattenNodes(snapshot.snapshot.root)
    .filter((node) => !isActionableNode(node) && !isGroupNode(node));
}

export function extractContextAnchorPreviews(
  snapshot: BrowserSnapshotResponse,
): ContextAnchorPreview[] {
  return extractContextAnchors(snapshot).map((node) => {
    const properties = getProperties(node);
    return {
      nodeId: node.nodeId,
      role: node.role,
      name: node.name,
      landmark: getStringProperty(properties, "landmark") || undefined,
      heading: getStringProperty(properties, "heading") || undefined,
      form: getStringProperty(properties, "form") || undefined,
      section: getStringProperty(properties, "section") || undefined,
    } satisfies ContextAnchorPreview;
  });
}

function formatContextNodeLine(node: ContextAnchorPreview): string {
  const parts = [node.nodeId, node.role ?? "unknown", node.name ?? "unnamed"];
  const context = formatContextSummary(node);
  if (context) {
    parts.push(context);
  }
  return `- ${parts.join(" | ")}`;
}

function formatGroupHeader(group: ActionableGroup): string {
  const parts = [group.name ?? "Unnamed group", group.role ?? "group"];
  const context = formatContextSummary(group);
  if (context) {
    parts.push(context);
  }
  parts.push(`${group.itemCount} refs`);
  if (group.inViewport) {
    parts.push("in-viewport");
  }
  return `- ${parts.join(" | ")}`;
}

function formatGroupedActionables(
  groups: ActionableGroup[],
  options: { maxPerGroup?: number } = {},
): string[] {
  const { maxPerGroup } = options;
  const lines: string[] = [];

  for (const group of groups) {
    lines.push(formatGroupHeader(group));
    const actionables =
      maxPerGroup == null
        ? group.actionables
        : group.actionables.slice(0, maxPerGroup);
    lines.push(
      ...actionables.map((actionable) => `  ${formatActionableLine(actionable).slice(2)}`),
    );
    if (
      maxPerGroup != null &&
      group.actionables.length > maxPerGroup
    ) {
      lines.push(`  - +${group.actionables.length - maxPerGroup} more refs`);
    }
  }

  return lines;
}

function summarizeRoleCounts(actionables: ActionablePreview[]): string {
  const counts = new Map<string, number>();
  for (const actionable of actionables) {
    const key = actionable.role ?? "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([role, count]) => `${role}:${count}`)
    .join(", ");
}

export function buildDiscoveryState(
  snapshot: BrowserSnapshotResponse,
): PageDiscoveryState {
  const actionables = extractActionablePreviews(snapshot);
  const groups = extractActionableGroups(snapshot);
  const contextAnchors = extractContextAnchorPreviews(snapshot);
  const inViewportCount = actionables.filter((actionable) => actionable.inViewport).length;
  const visibleGroups = groups.filter((group) => group.inViewport).length;

  return {
    pageVersion: snapshot.snapshot.version,
    page: snapshot.page,
    actionables,
    groups,
    contextAnchors,
    stats: {
      actionableCount: actionables.length,
      actionableGroups: groups.length,
      inViewportCount,
      visibleGroups,
      contextAnchors: contextAnchors.length,
      roleCounts: summarizeRoleCounts(actionables),
    },
  };
}

type DiscoveryRenderOptions = {
  headingLabel?: string;
  maxPerGroup?: number;
  maxContextAnchors?: number;
};

export function renderDiscoveryState(
  discovery: PageDiscoveryState,
  options: DiscoveryRenderOptions = {},
): string[] {
  const {
    headingLabel = "Interactive Areas",
    maxPerGroup = 4,
    maxContextAnchors = 8,
  } = options;

  const lines = [
    `- Page Version: ${discovery.pageVersion}`,
    `- Interactive Areas: ${discovery.stats.actionableGroups} (${discovery.stats.visibleGroups} in viewport)`,
    `- Actionable Refs: ${discovery.stats.actionableCount} (${discovery.stats.inViewportCount} in viewport)`,
    `- Role Counts: ${discovery.stats.roleCounts || "none"}`,
  ];

  if (discovery.groups.length) {
    lines.push(`- ${headingLabel}:`);
    lines.push(...formatGroupedActionables(discovery.groups, { maxPerGroup }));
  } else {
    lines.push("- No actionable refs found in the current snapshot.");
  }

  if (maxContextAnchors > 0 && discovery.contextAnchors.length) {
    lines.push("- Context Anchors:");
    lines.push(
      ...discovery.contextAnchors
        .slice(0, maxContextAnchors)
        .map(formatContextNodeLine),
    );
    if (discovery.contextAnchors.length > maxContextAnchors) {
      lines.push(
        `- +${discovery.contextAnchors.length - maxContextAnchors} more context anchors`,
      );
    }
  }

  return lines;
}

function renderSnapshot(snapshot: BrowserSnapshotResponse): string {
  return renderDiscoveryState(buildDiscoveryState(snapshot), {
    headingLabel: "Actionable Groups",
    maxPerGroup: 5,
  }).join("\n");
}

export async function getSnapshotResponse(
  context: Context,
  sessionId: string,
  options: { mode?: SnapshotMode; sinceVersion?: number; preferCache?: boolean } = {},
): Promise<BrowserSnapshotResponse> {
  const cachedSnapshot =
    options.preferCache !== false
      ? await context.getCachedSnapshot(sessionId, "fresh")
      : null;

  if (cachedSnapshot) {
    return cachedSnapshot;
  }

  const snapshot = await context.sendSocketMessage(
    "browser_snapshot",
    {
      mode: options.mode ?? "full",
      sinceVersion: options.sinceVersion,
    },
    undefined,
    sessionId,
  );

  return (
    (await context.getCachedSnapshot(sessionId, "current")) ??
    snapshot
  );
}

export async function getDiscoveryState(
  context: Context,
  sessionId: string,
  options: { mode?: SnapshotMode; sinceVersion?: number; preferCache?: boolean } = {},
): Promise<PageDiscoveryState> {
  const snapshot = await getSnapshotResponse(context, sessionId, options);
  return buildDiscoveryState(snapshot);
}

export async function captureAriaSnapshot(
  context: Context,
  sessionId: string,
  status = "",
  options: { mode?: SnapshotMode; sinceVersion?: number; preferCache?: boolean } = {},
): Promise<ToolResult> {
  const snapshot = await getSnapshotResponse(context, sessionId, options);
  const discovery = buildDiscoveryState(snapshot);

  return {
    content: [
      {
        type: "text",
        text: `${status ? `${status}\n` : ""}- Session ID: ${sessionId}
- Page URL: ${snapshot.page.url}
- Page Title: ${snapshot.page.title}
${renderDiscoveryState(discovery, {
  headingLabel: "Actionable Groups",
  maxPerGroup: 5,
}).join("\n")}
`,
      },
    ],
    structuredContent: {
      sessionId,
      pageVersion: discovery.pageVersion,
      page: snapshot.page,
      snapshot: snapshot.snapshot,
      discovery,
    },
  };
}

export async function captureActionables(
  context: Context,
  sessionId: string,
): Promise<ToolResult> {
  const discovery = await getDiscoveryState(context, sessionId, {
    preferCache: true,
  });

  const lines = [
    `- Session ID: ${sessionId}`,
    `- Page URL: ${discovery.page.url}`,
    `- Page Title: ${discovery.page.title}`,
    ...renderDiscoveryState(discovery, {
      headingLabel: "Actionable Groups",
      maxPerGroup: Number.POSITIVE_INFINITY,
      maxContextAnchors: 0,
    }),
  ];

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      sessionId,
      pageVersion: discovery.pageVersion,
      page: discovery.page,
      actionables: discovery.actionables,
      groups: discovery.groups,
      discovery,
    },
  };
}

export async function captureSessionOverview(
  context: Context,
  sessionId: string,
): Promise<ToolResult> {
  const discovery = await getDiscoveryState(context, sessionId, {
    preferCache: true,
  });

  const lines = [
    `- Session ID: ${sessionId}`,
    `- Page URL: ${discovery.page.url}`,
    `- Page Title: ${discovery.page.title}`,
    ...renderDiscoveryState(discovery),
  ];

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      sessionId,
      pageVersion: discovery.pageVersion,
      page: discovery.page,
      overview: discovery,
      discovery,
    },
  };
}

export function findTextInSnapshot(
  snapshot: BrowserSnapshotResponse,
  query: string,
): TextSearchMatch[] {
  const lowerQuery = query.toLowerCase();
  const flattened = flattenNodes(snapshot.snapshot.root);
  const matches: TextSearchMatch[] = [];

  for (const node of flattened) {
    const properties = getProperties(node);
    const name = node.name?.toLowerCase() ?? "";
    const value = node.value?.toLowerCase() ?? "";
    const href = getStringProperty(properties, "href").toLowerCase();

    const nameMatch = name.includes(lowerQuery);
    const valueMatch = value.includes(lowerQuery);
    const hrefMatch = href.includes(lowerQuery);

    if (!nameMatch && !valueMatch && !hrefMatch) {
      continue;
    }

    const matchParts: string[] = [];
    if (nameMatch) matchParts.push("name");
    if (valueMatch) matchParts.push("value");
    if (hrefMatch) matchParts.push("href");

    // If this node isn't actionable, find the nearest actionable ancestor
    let actionableRef = node.ref;
    if (!actionableRef) {
      actionableRef = findNearestActionableRef(flattened, node.nodeId, snapshot.snapshot.root);
    }

    matches.push({
      nodeId: node.nodeId,
      ref: actionableRef,
      role: node.role,
      name: node.name,
      value: node.value,
      href: getStringProperty(properties, "href") || undefined,
      actions: getStringArrayProperty(properties, "actions"),
      matchContext: `matched in: ${matchParts.join(", ")}`,
    });
  }

  return matches;
}

function findNearestActionableRef(
  _flattened: BrowserSnapshotNode[],
  targetNodeId: string,
  roots: BrowserSnapshotNode[],
): string | undefined {
  // Walk tree to find the target and track the path of actionable ancestors
  function findInTree(
    node: BrowserSnapshotNode,
    ancestorRef: string | undefined,
  ): string | undefined {
    const currentRef = node.ref ?? ancestorRef;
    if (node.nodeId === targetNodeId) {
      return currentRef;
    }
    for (const child of node.children ?? []) {
      const found = findInTree(child, currentRef);
      if (found) return found;
    }
    return undefined;
  }

  for (const root of roots) {
    const found = findInTree(root, undefined);
    if (found) return found;
  }
  return undefined;
}

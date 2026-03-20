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

export type DiscoveryFilters = {
  query?: string;
  exact?: boolean;
  roles?: string[];
  inViewportOnly?: boolean;
  groupQuery?: string;
  limit?: number;
  maxRefsPerGroup?: number;
  preferVisible?: boolean;
  preferRoles?: string[];
  preferHrefContains?: string;
};

export type ResolvedDiscoveryFilters = {
  query?: string;
  exact: boolean;
  roles: string[];
  inViewportOnly: boolean;
  groupQuery?: string;
  limit: number;
  maxRefsPerGroup: number;
  preferVisible: boolean;
  preferRoles: string[];
  preferHrefContains?: string;
};

export type DiscoverySelection = {
  pageVersion: number;
  page: BrowserSnapshotResponse["page"];
  filters: ResolvedDiscoveryFilters;
  totalMatches: number;
  returnedMatches: number;
  truncated: boolean;
  groups: ActionableGroup[];
  actionables: ActionablePreview[];
  recommendedRef?: string;
  recommendedActionables: ActionablePreview[];
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

function normalizeQuery(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function normalizeRoleList(values?: string[]): string[] {
  return [...new Set((values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

function matchesText(value: string | undefined, query: string, exact: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return exact ? normalized === query : normalized.includes(query);
}

function actionableSearchParts(actionable: ActionablePreview): string[] {
  return [
    actionable.name,
    actionable.value,
    actionable.href,
    actionable.placeholder,
    actionable.landmark,
    actionable.heading,
    actionable.form,
    actionable.section,
  ].filter((value): value is string => Boolean(value));
}

function groupSearchParts(group: ActionableGroup): string[] {
  return [group.name, group.landmark, group.heading, group.form, group.section].filter(
    (value): value is string => Boolean(value),
  );
}

function matchesQuery(parts: string[], query: string, exact: boolean): boolean {
  return parts.some((part) => matchesText(part, query, exact));
}

function resolveDiscoveryFilters(
  filters: DiscoveryFilters = {},
  defaults: {
    limit?: number;
    maxRefsPerGroup?: number;
    preferVisible?: boolean;
  } = {},
): ResolvedDiscoveryFilters {
  const limit = Math.max(1, Math.min(filters.limit ?? defaults.limit ?? 25, 200));
  const maxRefsPerGroup = Math.max(
    1,
    Math.min(filters.maxRefsPerGroup ?? defaults.maxRefsPerGroup ?? 5, 50),
  );

  return {
    query: normalizeQuery(filters.query),
    exact: filters.exact === true,
    roles: normalizeRoleList(filters.roles),
    inViewportOnly: filters.inViewportOnly === true,
    groupQuery: normalizeQuery(filters.groupQuery),
    limit,
    maxRefsPerGroup,
    preferVisible: filters.preferVisible ?? defaults.preferVisible ?? true,
    preferRoles: normalizeRoleList(filters.preferRoles),
    preferHrefContains: normalizeQuery(filters.preferHrefContains),
  };
}

function actionableMatchesFilters(
  actionable: ActionablePreview,
  group: ActionableGroup,
  filters: ResolvedDiscoveryFilters,
): boolean {
  if (filters.roles.length) {
    const role = actionable.role?.toLowerCase() ?? "";
    if (!filters.roles.includes(role)) {
      return false;
    }
  }

  if (filters.inViewportOnly && !actionable.inViewport) {
    return false;
  }

  if (filters.groupQuery && !matchesQuery(groupSearchParts(group), filters.groupQuery, false)) {
    return false;
  }

  if (filters.query && !matchesQuery(actionableSearchParts(actionable), filters.query, filters.exact)) {
    return false;
  }

  return true;
}

function scoreActionable(
  actionable: ActionablePreview,
  filters: ResolvedDiscoveryFilters,
): number {
  let score = 0;

  if (actionable.inViewport) {
    score += 100;
  }
  if (filters.preferVisible && actionable.inViewport) {
    score += 40;
  }

  const role = actionable.role?.toLowerCase() ?? "";
  if (filters.preferRoles.length && filters.preferRoles.includes(role)) {
    score += 60;
  }
  if (role === "button") {
    score += 25;
  } else if (role === "link") {
    score += 20;
  } else if (role === "textbox" || role === "combobox") {
    score += 18;
  }

  if (filters.preferHrefContains && matchesText(actionable.href, filters.preferHrefContains, false)) {
    score += 45;
  }

  if (filters.query) {
    if (matchesText(actionable.name, filters.query, true)) {
      score += 160;
    } else if (matchesText(actionable.name, filters.query, false)) {
      score += 110;
    }

    if (matchesText(actionable.value, filters.query, true)) {
      score += 120;
    } else if (matchesText(actionable.value, filters.query, false)) {
      score += 70;
    }

    if (matchesText(actionable.href, filters.query, true)) {
      score += 100;
    } else if (matchesText(actionable.href, filters.query, false)) {
      score += 65;
    }

    if (
      matchesText(actionable.heading, filters.query, false) ||
      matchesText(actionable.form, filters.query, false) ||
      matchesText(actionable.section, filters.query, false)
    ) {
      score += 35;
    }
  }

  if (!actionable.disabled) {
    score += 8;
  }

  return score;
}

export function selectActionables(
  discovery: PageDiscoveryState,
  filters: DiscoveryFilters = {},
  defaults: {
    limit?: number;
    maxRefsPerGroup?: number;
    preferVisible?: boolean;
  } = {},
): DiscoverySelection {
  const resolved = resolveDiscoveryFilters(filters, defaults);
  const matchedCountByGroup = new Map<string, number>();
  const entries: Array<{
    actionable: ActionablePreview;
    group: ActionableGroup;
    score: number;
    groupIndex: number;
  }> = [];

  discovery.groups.forEach((group, groupIndex) => {
    group.actionables.forEach((actionable) => {
      if (!actionableMatchesFilters(actionable, group, resolved)) {
        return;
      }
      matchedCountByGroup.set(group.nodeId, (matchedCountByGroup.get(group.nodeId) ?? 0) + 1);
      entries.push({
        actionable,
        group,
        score: scoreActionable(actionable, resolved),
        groupIndex,
      });
    });
  });

  entries.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.groupIndex - right.groupIndex;
  });

  const selected: typeof entries = [];
  const selectedPerGroup = new Map<string, number>();
  for (const entry of entries) {
    if (selected.length >= resolved.limit) {
      break;
    }
    const groupCount = selectedPerGroup.get(entry.group.nodeId) ?? 0;
    if (groupCount >= resolved.maxRefsPerGroup) {
      continue;
    }
    selected.push(entry);
    selectedPerGroup.set(entry.group.nodeId, groupCount + 1);
  }

  const selectedGroups = new Map<string, ActionableGroup>();
  for (const entry of selected) {
    const existing = selectedGroups.get(entry.group.nodeId);
    if (existing) {
      existing.actionables.push(entry.actionable);
      continue;
    }
    selectedGroups.set(entry.group.nodeId, {
      ...entry.group,
      itemCount: matchedCountByGroup.get(entry.group.nodeId) ?? entry.group.itemCount,
      actionables: [entry.actionable],
    });
  }

  const groups = discovery.groups
    .map((group) => selectedGroups.get(group.nodeId))
    .filter((group): group is ActionableGroup => Boolean(group));
  const actionables = selected.map((entry) => entry.actionable);

  return {
    pageVersion: discovery.pageVersion,
    page: discovery.page,
    filters: resolved,
    totalMatches: entries.length,
    returnedMatches: actionables.length,
    truncated: actionables.length < entries.length,
    groups,
    actionables,
    recommendedRef: actionables[0]?.ref,
    recommendedActionables: actionables.slice(0, 5),
    stats: discovery.stats,
  };
}

function formatSelectionFilters(filters: ResolvedDiscoveryFilters): string | null {
  const parts = [
    filters.query ? `query="${filters.query}"` : null,
    filters.exact ? "exact=true" : null,
    filters.roles.length ? `roles=${filters.roles.join(",")}` : null,
    filters.inViewportOnly ? "inViewportOnly=true" : null,
    filters.groupQuery ? `group="${filters.groupQuery}"` : null,
    filters.preferRoles.length ? `preferRoles=${filters.preferRoles.join(",")}` : null,
    filters.preferHrefContains ? `preferHrefContains="${filters.preferHrefContains}"` : null,
    `limit=${filters.limit}`,
    `maxRefsPerGroup=${filters.maxRefsPerGroup}`,
  ].filter((value): value is string => Boolean(value));

  return parts.length ? parts.join(" | ") : null;
}

export function renderDiscoverySelection(
  selection: DiscoverySelection,
  options: { headingLabel?: string } = {},
): string[] {
  const headingLabel = options.headingLabel ?? "Matching Actionable Areas";
  const lines = [
    `- Page Version: ${selection.pageVersion}`,
    `- Matched Refs: ${selection.returnedMatches} of ${selection.totalMatches}`,
  ];

  if (selection.recommendedActionables[0]) {
    lines.push(
      `- Recommended Ref: ${formatActionableLine(selection.recommendedActionables[0]).slice(2)}`,
    );
  }

  const filterLine = formatSelectionFilters(selection.filters);
  if (filterLine) {
    lines.push(`- Applied Filters: ${filterLine}`);
  }
  if (selection.truncated) {
    lines.push("- Result Set: truncated; tighten the query or increase limit for more refs");
  }

  if (selection.groups.length) {
    lines.push(`- ${headingLabel}:`);
    lines.push(
      ...formatGroupedActionables(selection.groups, {
        maxPerGroup: selection.filters.maxRefsPerGroup,
      }),
    );
  } else {
    lines.push("- No actionable refs matched the current filters.");
  }

  return lines;
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
    "tabductor_snapshot",
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
- Snapshot Shape: compact semantic tree; not a full DOM or full URL inventory
- If a target or href is missing, use tabductor_actionables with filters, tabductor_find_text for a recommended ref, or tabductor_describe_ref for one ref
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
      guidance: {
        snapshotShape: "compact-semantic-tree",
        notFullDom: true,
        elaborationTools: [
          "tabductor_actionables",
          "tabductor_find_text",
          "tabductor_describe_ref",
        ],
      },
    },
  };
}

export async function captureActionables(
  context: Context,
  sessionId: string,
  filters: DiscoveryFilters = {},
): Promise<ToolResult> {
  const discovery = await getDiscoveryState(context, sessionId, {
    preferCache: true,
  });
  const selection = selectActionables(discovery, filters, {
    limit: 25,
    maxRefsPerGroup: 5,
  });

  const lines = [
    `- Session ID: ${sessionId}`,
    `- Page URL: ${discovery.page.url}`,
    `- Page Title: ${discovery.page.title}`,
    ...renderDiscoverySelection(selection, {
      headingLabel: "Actionable Areas",
    }),
  ];

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      sessionId,
      pageVersion: selection.pageVersion,
      page: selection.page,
      filters: selection.filters,
      totalMatches: selection.totalMatches,
      returnedMatches: selection.returnedMatches,
      truncated: selection.truncated,
      recommendedRef: selection.recommendedRef,
      matchedRefs: selection.actionables,
      groups: selection.groups,
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
  const selection = selectActionables(discovery, {}, {
    limit: 12,
    maxRefsPerGroup: 3,
  });
  const selectionLines = renderDiscoverySelection(selection, {
    headingLabel: "Recommended Actionable Areas",
  }).filter(
    (line) =>
      !line.startsWith("- Page Version:") &&
      !line.startsWith("- Applied Filters:"),
  );

  const lines = [
    `- Session ID: ${sessionId}`,
    `- Page URL: ${discovery.page.url}`,
    `- Page Title: ${discovery.page.title}`,
    `- Page Version: ${discovery.pageVersion}`,
    `- Interactive Areas: ${discovery.stats.actionableGroups} (${discovery.stats.visibleGroups} in viewport)`,
    `- Actionable Refs: ${discovery.stats.actionableCount} (${discovery.stats.inViewportCount} in viewport)`,
    `- Role Counts: ${discovery.stats.roleCounts || "none"}`,
    ...selectionLines,
    ...(discovery.contextAnchors.length
      ? [
          "- Context Anchors:",
          ...discovery.contextAnchors
            .slice(0, 6)
            .map(formatContextNodeLine),
          ...(discovery.contextAnchors.length > 6
            ? [`- +${discovery.contextAnchors.length - 6} more context anchors`]
            : []),
        ]
      : []),
  ];

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      sessionId,
      pageVersion: discovery.pageVersion,
      page: discovery.page,
      overview: {
        stats: discovery.stats,
        recommendedRef: selection.recommendedRef,
        recommendedRefs: selection.recommendedActionables,
        groups: selection.groups,
        contextAnchors: discovery.contextAnchors.slice(0, 6),
      },
    },
  };
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

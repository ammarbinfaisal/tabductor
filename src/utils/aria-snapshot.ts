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
  if (node.disabled) {
    parts.push("disabled");
  }

  return `- ${parts.join(" | ")}`;
}

export function extractActionablePreviews(
  snapshot: BrowserSnapshotResponse,
): ActionablePreview[] {
  const flattened = flattenNodes(snapshot.snapshot.root);
  return flattened
    .filter(isActionableNode)
    .map((node) => {
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
      } satisfies ActionablePreview;
    });
}

function extractContextAnchors(
  snapshot: BrowserSnapshotResponse,
): BrowserSnapshotNode[] {
  return flattenNodes(snapshot.snapshot.root)
    .filter((node) => !isActionableNode(node) && !isGroupNode(node));
}

function formatContextNodeLine(node: BrowserSnapshotNode): string {
  const parts = [node.nodeId, node.role ?? "unknown", node.name ?? "unnamed"];
  return `- ${parts.join(" | ")}`;
}

function renderSnapshot(snapshot: BrowserSnapshotResponse): string {
  const actionables = extractActionablePreviews(snapshot);
  const contextAnchors = extractContextAnchors(snapshot);

  const lines = [
    `- Snapshot Version: ${snapshot.snapshot.version}`,
    `- Actionable Refs: ${actionables.length}`,
    `- Context Anchors: ${contextAnchors.length}`,
  ];

  if (actionables.length) {
    lines.push("- Actionable Refs:");
    lines.push(...actionables.map(formatActionableLine));
  }

  if (contextAnchors.length) {
    lines.push("- Context Anchors:");
    lines.push(...contextAnchors.map(formatContextNodeLine));
  }

  return lines.join("\n");
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

export async function captureAriaSnapshot(
  context: Context,
  sessionId: string,
  status = "",
  options: { mode?: SnapshotMode; sinceVersion?: number; preferCache?: boolean } = {},
): Promise<ToolResult> {
  const snapshot = await getSnapshotResponse(context, sessionId, options);

  return {
    content: [
      {
        type: "text",
        text: `${status ? `${status}\n` : ""}- Session ID: ${sessionId}
- Page URL: ${snapshot.page.url}
- Page Title: ${snapshot.page.title}
${renderSnapshot(snapshot)}
`,
      },
    ],
    structuredContent: {
      sessionId,
      page: snapshot.page,
      snapshot: snapshot.snapshot,
    },
  };
}

export async function captureActionables(
  context: Context,
  sessionId: string,
): Promise<ToolResult> {
  const snapshot = await getSnapshotResponse(context, sessionId, {
    preferCache: true,
  });
  const actionables = extractActionablePreviews(snapshot);

  const lines = [
    `- Session ID: ${sessionId}`,
    `- Page URL: ${snapshot.page.url}`,
    `- Page Title: ${snapshot.page.title}`,
    `- Snapshot Version: ${snapshot.snapshot.version}`,
    `- Actionable Refs: ${actionables.length}`,
    ...(actionables.length
      ? ["- Actionable Refs:", ...actionables.map(formatActionableLine)]
      : ["- No actionable refs found in the current snapshot."]),
  ];

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      sessionId,
      snapshotVersion: snapshot.snapshot.version,
      page: snapshot.page,
      actionables,
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

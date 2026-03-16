import {
  BrowserInvalidationEvent,
  BrowserSnapshotNode,
  BrowserSnapshotResponse,
} from "@/protocol/messages";

export type SnapshotNodeSummary = {
  nodeId: string;
  ref?: string;
  role?: string;
  name?: string;
};

export type SnapshotChangeSummary = {
  fromVersion: number | null;
  toVersion: number;
  snapshotMode?: "full" | "delta";
  reason?: BrowserInvalidationEvent["reason"];
  scope?: BrowserInvalidationEvent["scope"];
  summary?: string;
  added: SnapshotNodeSummary[];
  removed: SnapshotNodeSummary[];
  updated: SnapshotNodeSummary[];
};

function summarizeNode(node: BrowserSnapshotNode): SnapshotNodeSummary {
  return {
    nodeId: node.nodeId,
    ref: node.ref,
    role: node.role,
    name: node.name,
  };
}

function flattenNodes(nodes: BrowserSnapshotNode[]): Map<string, BrowserSnapshotNode> {
  const map = new Map<string, BrowserSnapshotNode>();
  const visit = (node: BrowserSnapshotNode) => {
    map.set(node.nodeId, node);
    for (const child of node.children ?? []) {
      visit(child);
    }
  };

  for (const node of nodes) {
    visit(node);
  }

  return map;
}

function fingerprintNode(node: BrowserSnapshotNode): string {
  return JSON.stringify({
    ref: node.ref,
    role: node.role,
    name: node.name,
    value: node.value,
    description: node.description,
    properties: node.properties,
  });
}

function mergeDeltaSnapshot(
  current: BrowserSnapshotResponse,
  delta: BrowserSnapshotResponse,
): BrowserSnapshotResponse {
  const deltaNodes = flattenNodes(delta.snapshot.root);
  const deltaById = new Map<string, BrowserSnapshotNode>();
  for (const [nodeId, node] of deltaNodes) {
    deltaById.set(nodeId, node);
  }

  // If delta contains nodes absent from current tree, fall back to full replacement
  const currentIdSet = new Set(flattenNodes(current.snapshot.root).keys());
  const hasNewRoots = delta.snapshot.root.some((n) => !currentIdSet.has(n.nodeId));
  if (hasNewRoots) {
    return { ...delta, snapshot: { ...delta.snapshot, mode: "full" } };
  }

  function mergeNode(node: BrowserSnapshotNode): BrowserSnapshotNode {
    const replacement = deltaById.get(node.nodeId);
    if (replacement) {
      return {
        ...replacement,
        children: (replacement.children ?? []).map(mergeNode),
      };
    }
    return {
      ...node,
      children: (node.children ?? []).map(mergeNode),
    };
  }

  return {
    page: delta.page,
    snapshot: {
      ...current.snapshot,
      version: delta.snapshot.version,
      generatedAt: delta.snapshot.generatedAt,
      mode: "full",
      root: current.snapshot.root.map(mergeNode),
      invalidation: delta.snapshot.invalidation ?? current.snapshot.invalidation,
    },
  };
}

export class SnapshotCache {
  private current: BrowserSnapshotResponse | null = null;
  private lastChange: SnapshotChangeSummary | null = null;
  private fresh = false;

  clone(): SnapshotCache {
    const clone = new SnapshotCache();
    clone.current = this.current;
    clone.lastChange = this.lastChange;
    clone.fresh = this.fresh;
    return clone;
  }

  getCurrent(): BrowserSnapshotResponse | null {
    return this.current;
  }

  getFreshSnapshot(): BrowserSnapshotResponse | null {
    return this.fresh ? this.current : null;
  }

  isFresh(): boolean {
    return this.fresh;
  }

  getLastChange(): SnapshotChangeSummary | null {
    return this.lastChange;
  }

  ingestSnapshot(snapshot: BrowserSnapshotResponse): SnapshotChangeSummary {
    const previous = this.current;
    const isDelta = snapshot.snapshot.mode === "delta" && previous != null;
    const merged = isDelta ? mergeDeltaSnapshot(previous!, snapshot) : snapshot;

    const previousNodes = flattenNodes(previous?.snapshot.root ?? []);
    const nextNodes = flattenNodes(merged.snapshot.root);

    const added: SnapshotNodeSummary[] = [];
    const removed: SnapshotNodeSummary[] = [];
    const updated: SnapshotNodeSummary[] = [];

    for (const [nodeId, nextNode] of nextNodes) {
      const previousNode = previousNodes.get(nodeId);
      if (!previousNode) {
        added.push(summarizeNode(nextNode));
        continue;
      }

      if (fingerprintNode(previousNode) !== fingerprintNode(nextNode)) {
        updated.push(summarizeNode(nextNode));
      }
    }

    for (const [nodeId, previousNode] of previousNodes) {
      if (!nextNodes.has(nodeId)) {
        removed.push(summarizeNode(previousNode));
      }
    }

    this.current = merged;
    this.fresh = merged.snapshot.mode === "full";
    this.lastChange = {
      fromVersion: previous?.snapshot.version ?? null,
      toVersion: merged.snapshot.version,
      snapshotMode: merged.snapshot.mode,
      reason: merged.snapshot.invalidation?.reason,
      scope: merged.snapshot.invalidation?.scope,
      summary: merged.snapshot.invalidation?.summary,
      added,
      removed,
      updated,
    };
    return this.lastChange;
  }

  noteInvalidation(event: BrowserInvalidationEvent) {
    const currentVersion = this.current?.snapshot.version ?? null;
    this.fresh = false;

    this.lastChange = {
      fromVersion: currentVersion,
      toVersion: event.version,
      reason: event.reason,
      scope: event.scope,
      summary: event.summary,
      added: [],
      removed: [],
      updated: [],
    };
  }
}

import { randomUUID } from "node:crypto";

import { WebSocket } from "ws";

import { mcpConfig } from "@/config";
import {
  BrowserConsoleEntryNotification,
  BrowserInvalidationEvent,
  BrowserNotificationMap,
  BrowserNotificationType,
  BrowserPageState,
  BrowserRequestMap,
  BrowserRequestType,
  BrowserSessionCapabilities,
  BrowserSessionHello,
  BrowserSnapshotResponse,
  BrowserStructuredSnapshot,
  BrowserSnapshotUpdate,
  BrowserPageUpdate,
} from "@/protocol/messages";
import { createRpcClient } from "@/protocol/ws-rpc";
import { SnapshotCache, SnapshotChangeSummary } from "@/snapshot-cache";
import { logException, logInfo } from "@/utils/log";

export const noConnectionMessage = `No connection to browser extension. In order to proceed, you must first connect a tab by clicking the Tabductor extension icon in the browser toolbar and clicking the 'Connect' button.`;

export type BrowserSessionState = {
  sessionId: string;
  connectedAt: string;
  status: "connecting" | "ready" | "closed";
  page: BrowserPageState | null;
  pageVersion: number | null;
  lastInvalidation: BrowserInvalidationEvent | null;
  lastChange: SnapshotChangeSummary | null;
  capabilities: BrowserSessionCapabilities | null;
  extensionVersion?: string;
  browserName?: string;
  userAgent?: string;
};

type SessionMetadata = Omit<BrowserSessionState, "sessionId" | "connectedAt">;

type BrowserSessionCallbacks = {
  onHello?: (session: BrowserSession, payload: BrowserSessionHello) => void;
  onClose?: (session: BrowserSession) => void;
};

export type BrowserSessionNotificationListener = (
  event: BrowserNotificationType,
  payload: BrowserNotificationMap[BrowserNotificationType]["payload"],
) => void;

export class BrowserSession {
  id = randomUUID();
  connectedAt = new Date();
  private ws: WebSocket | null;
  private rpcClient: ReturnType<typeof createRpcClient> | null = null;
  private stateRevision = 0;
  private lastRemoteSnapshotVersion: number | null = null;
  private lastLogicalSnapshotVersion: number | null = null;
  private readonly stateListeners = new Set<() => void>();
  private readonly notificationListeners =
    new Set<BrowserSessionNotificationListener>();
  private metadata: SessionMetadata = {
    status: "connecting",
    page: null,
    pageVersion: null,
    lastInvalidation: null,
    lastChange: null,
    capabilities: null,
  };
  private snapshotCache = new SnapshotCache();
  private closedAt: Date | null = null;

  constructor(ws: WebSocket, private readonly callbacks: BrowserSessionCallbacks = {}) {
    this.ws = null;
    this.attachConnection(ws);
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  isClosed(): boolean {
    return this.metadata.status === "closed";
  }

  getClosedAt(): Date | null {
    return this.closedAt;
  }

  getStateRevision(): number {
    return this.stateRevision;
  }

  getState(): BrowserSessionState {
    return {
      sessionId: this.id,
      connectedAt: this.connectedAt.toISOString(),
      ...this.metadata,
    };
  }

  getLastSnapshot(): BrowserSnapshotResponse | null {
    return this.snapshotCache.getCurrent();
  }

  getFreshSnapshot(): BrowserSnapshotResponse | null {
    return this.snapshotCache.getFreshSnapshot();
  }

  getTabId(): number | undefined {
    return this.metadata.page?.tabId;
  }

  assumeContinuityFrom(previous: BrowserSession) {
    this.id = previous.id;
    this.connectedAt = previous.connectedAt;
    this.stateRevision = previous.stateRevision + 1;
    this.snapshotCache = previous.snapshotCache.clone();
    this.lastRemoteSnapshotVersion = null;
    this.lastLogicalSnapshotVersion = previous.metadata.pageVersion;
    this.metadata = {
      ...previous.metadata,
      ...this.metadata,
      lastChange: this.metadata.lastChange ?? previous.metadata.lastChange,
      lastInvalidation:
        this.metadata.lastInvalidation ?? previous.metadata.lastInvalidation,
    };
    for (const listener of previous.notificationListeners) {
      this.notificationListeners.add(listener);
    }
  }

  retire() {
    this.ws = null;
    this.rpcClient = null;
    this.closedAt = new Date();
    this.metadata.status = "closed";
  }

  async waitForStateChangeSince(
    revision: number,
    timeoutMs = 2000,
  ): Promise<boolean> {
    if (this.stateRevision > revision) {
      return true;
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.stateListeners.delete(onChange);
        resolve(false);
      }, timeoutMs);

      const onChange = () => {
        clearTimeout(timeout);
        this.stateListeners.delete(onChange);
        resolve(true);
      };

      this.stateListeners.add(onChange);
    });
  }

  async sendSocketMessage<T extends BrowserRequestType>(
    type: T,
    payload: BrowserRequestMap[T]["payload"],
    options: { timeoutMs?: number } = { timeoutMs: 30000 },
  ) {
    if (!this.rpcClient || !this.isOpen()) {
      throw new Error(noConnectionMessage);
    }

    const startedAt = Date.now();
    logInfo("tabductor.requests", "Sending Tabductor request", {
      payload,
      sessionId: this.id,
      timeoutMs: options.timeoutMs ?? 30000,
      type,
    });
    try {
      const result = await this.rpcClient.sendRequest(type, payload, options);
      this.absorbRequestResult(type, result);
      logInfo("tabductor.responses", "Tabductor request completed", {
        durationMs: Date.now() - startedAt,
        result,
        sessionId: this.id,
        type,
      });
      return result;
    } catch (e) {
      logException("tabductor.errors", "Tabductor request failed", e, {
        durationMs: Date.now() - startedAt,
        payload,
        sessionId: this.id,
        type,
      });
      if (
        e instanceof Error &&
        (e.message === mcpConfig.errors.noConnectedTab ||
          e.message.includes(mcpConfig.errors.noConnectedTab))
      ) {
        throw new Error(noConnectionMessage);
      }
      throw e;
    }
  }

  async close() {
    if (!this.ws) {
      return;
    }
    await this.ws.close();
  }

  subscribeToNotifications(listener: BrowserSessionNotificationListener) {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  private handleNotification<T extends BrowserNotificationType>(
    event: T,
    payload: unknown,
  ) {
    logInfo("tabductor.notifications", "Tabductor notification received", {
      event,
      payload,
      sessionId: this.id,
    });
    for (const listener of this.notificationListeners) {
      listener(event, payload as BrowserNotificationMap[T]["payload"]);
    }
    switch (event) {
      case "tabductor.session.hello":
        this.applyHello(payload as BrowserSessionHello);
        return;
      case "tabductor.page.updated":
        this.applyPageUpdate(payload as BrowserPageUpdate);
        return;
      case "tabductor.snapshot.updated":
        this.applySnapshotUpdate(payload as BrowserSnapshotUpdate);
        return;
      case "tabductor.console.entry":
        this.applyConsoleEntry(payload as BrowserConsoleEntryNotification);
        return;
    }
  }

  private applyHello(payload: BrowserSessionHello) {
    this.metadata = {
      ...this.metadata,
      status: "ready",
      page: payload.page,
      pageVersion: this.toLogicalSnapshotVersion(payload.snapshotVersion) ?? this.metadata.pageVersion,
      capabilities: payload.capabilities,
      extensionVersion: payload.extensionVersion,
      browserName: payload.browserName,
      userAgent: payload.userAgent,
    };
    this.closedAt = null;
    this.bumpStateRevision();
    logInfo("tabductor.notifications", "Tabductor session is ready", {
      page: payload.page,
      sessionId: this.id,
      snapshotVersion: payload.snapshotVersion,
    });
    this.callbacks.onHello?.(this, payload);
  }

  private applyPageUpdate(payload: BrowserPageUpdate) {
    const logicalSnapshotVersion = this.toLogicalSnapshotVersion(payload.snapshotVersion);
    this.metadata = {
      ...this.metadata,
      status: "ready",
      page: payload.page,
      pageVersion: logicalSnapshotVersion ?? this.metadata.pageVersion,
      lastInvalidation:
        this.toLogicalInvalidation(payload.invalidation) ?? this.metadata.lastInvalidation,
    };
    if (payload.invalidation) {
      this.snapshotCache.noteInvalidation(this.toLogicalInvalidation(payload.invalidation)!);
      this.metadata.lastChange = this.snapshotCache.getLastChange();
    }
    this.bumpStateRevision();
    logInfo("tabductor.notifications", "Tabductor page updated", {
      invalidation: payload.invalidation,
      page: payload.page,
      sessionId: this.id,
      snapshotVersion: payload.snapshotVersion,
    });
  }

  private applySnapshotUpdate(payload: BrowserSnapshotUpdate) {
    const snapshot = this.toLogicalSnapshot(payload.snapshot);
    const page = payload.page ?? this.metadata.page;
    if (page) {
      this.metadata.page = page;
    }
    this.metadata.status = "ready";
    this.metadata.pageVersion = snapshot.version;
    this.metadata.lastInvalidation =
      snapshot.invalidation ?? this.metadata.lastInvalidation;
    if (page) {
      this.snapshotCache.ingestSnapshot({
        page,
        snapshot,
      });
      this.metadata.lastChange = this.snapshotCache.getLastChange();
    }
    this.bumpStateRevision();
    logInfo("tabductor.notifications", "Tabductor snapshot updated", {
      page,
      sessionId: this.id,
      snapshotVersion: snapshot.version,
    });
  }

  private applyConsoleEntry(_payload: BrowserConsoleEntryNotification) {
    this.bumpStateRevision();
  }

  private absorbRequestResult<T extends BrowserRequestType>(
    type: T,
    result: BrowserRequestMap[T]["result"],
  ) {
    switch (type) {
      case "tabductor_snapshot": {
        const snapshot = this.toLogicalSnapshotResponse(result as BrowserSnapshotResponse);
        this.metadata.status = "ready";
        this.metadata.page = snapshot.page;
        this.metadata.pageVersion = snapshot.snapshot.version;
        this.metadata.lastInvalidation =
          snapshot.snapshot.invalidation ?? this.metadata.lastInvalidation;
        this.snapshotCache.ingestSnapshot(snapshot);
        this.metadata.lastChange = this.snapshotCache.getLastChange();
        this.bumpStateRevision();
        return;
      }
      default:
        return;
    }
  }

  private toLogicalSnapshotVersion(
    remoteVersion: number | null | undefined,
  ): number | null | undefined {
    if (remoteVersion == null) {
      return remoteVersion;
    }

    if (
      this.lastRemoteSnapshotVersion === remoteVersion &&
      this.lastLogicalSnapshotVersion != null
    ) {
      return this.lastLogicalSnapshotVersion;
    }

    const currentLogicalVersion =
      this.metadata.pageVersion ?? this.lastLogicalSnapshotVersion;

    let logicalVersion: number;
    if (
      this.lastRemoteSnapshotVersion != null &&
      this.lastLogicalSnapshotVersion != null &&
      remoteVersion > this.lastRemoteSnapshotVersion
    ) {
      logicalVersion =
        this.lastLogicalSnapshotVersion +
        (remoteVersion - this.lastRemoteSnapshotVersion);
    } else if (currentLogicalVersion != null && remoteVersion <= currentLogicalVersion) {
      logicalVersion = currentLogicalVersion + 1;
    } else {
      logicalVersion = remoteVersion;
    }

    this.lastRemoteSnapshotVersion = remoteVersion;
    this.lastLogicalSnapshotVersion = logicalVersion;
    return logicalVersion;
  }

  private toLogicalInvalidation(
    invalidation: BrowserInvalidationEvent | null | undefined,
  ): BrowserInvalidationEvent | null | undefined {
    if (!invalidation) {
      return invalidation;
    }

    return {
      ...invalidation,
      version: this.toLogicalSnapshotVersion(invalidation.version) ?? invalidation.version,
    };
  }

  private toLogicalSnapshot(
    snapshot: BrowserStructuredSnapshot,
  ): BrowserStructuredSnapshot {
    return {
      ...snapshot,
      version: this.toLogicalSnapshotVersion(snapshot.version) ?? snapshot.version,
      invalidation: this.toLogicalInvalidation(snapshot.invalidation),
    };
  }

  private toLogicalSnapshotResponse(
    snapshot: BrowserSnapshotResponse,
  ): BrowserSnapshotResponse {
    return {
      ...snapshot,
      snapshot: this.toLogicalSnapshot(snapshot.snapshot),
    };
  }

  private bumpStateRevision() {
    this.stateRevision += 1;
    for (const notify of this.stateListeners) {
      notify();
    }
  }

  private attachConnection(ws: WebSocket) {
    this.ws = ws;
    logInfo("daemon.lifecycle", "Attached browser session websocket", {
      sessionId: this.id,
    });
    this.rpcClient = createRpcClient(ws, {
      onNotification: (event, payload) => {
        if (this.ws !== ws) {
          return;
        }
        this.handleNotification(event, payload);
      },
    });

    ws.on("close", () => {
      if (this.ws !== ws) {
        return;
      }
      this.ws = null;
      this.rpcClient = null;
      this.closedAt = new Date();
      this.metadata.status = "closed";
      this.bumpStateRevision();
      logInfo("daemon.lifecycle", "Browser session websocket closed", {
        sessionId: this.id,
      });
      this.callbacks.onClose?.(this);
    });
  }

}

export class SessionManager {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly sessionIdsByTabId = new Map<number, string>();
  private readonly closedSessionTtlMs = 30_000;

  add(ws: WebSocket): BrowserSession {
    this.pruneExpiredClosedSessions();
    const session = new BrowserSession(ws, {
      onHello: (connectedSession, payload) => {
        this.bindSessionToTab(connectedSession, payload);
      },
    });
    this.sessions.set(session.id, session);
    return session;
  }

  remove(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const tabId = session.getTabId();
    if (tabId != null && this.sessionIdsByTabId.get(tabId) === sessionId) {
      this.sessionIdsByTabId.delete(tabId);
    }
    this.sessions.delete(sessionId);
  }

  list(): BrowserSession[] {
    this.pruneExpiredClosedSessions();
    return [...this.sessions.values()];
  }

  hasSessions(): boolean {
    return this.sessions.size > 0;
  }

  async waitForStateChangeSince(
    sessionId: string,
    revision: number,
    timeoutMs = 2000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const session = this.get(sessionId);
      const remainingMs = Math.max(1, deadline - Date.now());
      const changed = await session.waitForStateChangeSince(
        revision,
        Math.min(remainingMs, 250),
      );
      if (changed) {
        return true;
      }
      if (session.getStateRevision() > revision) {
        return true;
      }
    }

    return this.get(sessionId).getStateRevision() > revision;
  }

  get(sessionId: string): BrowserSession {
    this.pruneExpiredClosedSessions();
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(
        `Session "${sessionId}" not found. Use tabductor_sessions to inspect available sessions.`,
      );
    }

    return session;
  }

  async closeAll() {
    await Promise.all(this.list().map((session) => session.close()));
    this.sessions.clear();
    this.sessionIdsByTabId.clear();
  }

  private bindSessionToTab(session: BrowserSession, payload: BrowserSessionHello) {
    const tabId = payload.page.tabId;
    if (tabId == null) {
      return;
    }

    const existingSessionId = this.sessionIdsByTabId.get(tabId);
    if (!existingSessionId || existingSessionId === session.id) {
      this.sessionIdsByTabId.set(tabId, session.id);
      return;
    }

    const existingSession = this.sessions.get(existingSessionId);
    if (!existingSession) {
      this.sessionIdsByTabId.set(tabId, session.id);
      return;
    }

    const transientSessionId = session.id;
    session.assumeContinuityFrom(existingSession);
    this.sessions.delete(transientSessionId);
    existingSession.retire();
    this.sessions.set(session.id, session);
    this.sessionIdsByTabId.set(tabId, session.id);
  }

  private pruneExpiredClosedSessions() {
    const cutoff = Date.now() - this.closedSessionTtlMs;
    for (const [sessionId, session] of this.sessions) {
      const closedAt = session.getClosedAt();
      if (!closedAt || closedAt.getTime() >= cutoff) {
        continue;
      }
      this.remove(sessionId);
    }
  }
}

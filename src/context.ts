import { WebSocket } from "ws";

import { DaemonClient } from "@/daemon/client";
import type { DaemonSessionState } from "@/daemon/protocol";
import { BrowserRequestMap, BrowserRequestType } from "@/protocol/messages";
import {
  BrowserSession,
  BrowserSessionNotificationListener,
  BrowserSessionState,
  SessionManager,
} from "@/session";

type CachedSnapshotFreshness = "current" | "fresh";

function stripRevision(session: DaemonSessionState): BrowserSessionState {
  const { revision: _revision, ...state } = session;
  return state;
}

export class Context {
  private constructor(
    private readonly sessionManager: SessionManager | null,
    private readonly daemonClient: DaemonClient | null,
  ) {}

  static createLocal(): Context {
    return new Context(new SessionManager(), null);
  }

  static async createRemote(): Promise<Context> {
    return new Context(null, await DaemonClient.connect());
  }

  addSession(ws: WebSocket): BrowserSession {
    if (!this.sessionManager) {
      throw new Error("Remote Tabductor context cannot accept browser sessions");
    }
    return this.sessionManager.add(ws);
  }

  async listSessions(): Promise<BrowserSessionState[]> {
    if (this.sessionManager) {
      return this.sessionManager.list().map((session) => session.getState());
    }
    return (await this.daemonClient!.listSessions()).map(stripRevision);
  }

  async listSessionsWithRevision(): Promise<DaemonSessionState[]> {
    if (this.sessionManager) {
      return this.sessionManager.list().map((session) => ({
        ...session.getState(),
        revision: session.getStateRevision(),
      }));
    }
    return await this.daemonClient!.listSessions();
  }

  async getSessionState(sessionId: string): Promise<BrowserSessionState> {
    if (this.sessionManager) {
      return this.sessionManager.get(sessionId).getState();
    }
    return stripRevision(await this.daemonClient!.getSessionState(sessionId));
  }

  async getSessionStateWithRevision(
    sessionId: string,
  ): Promise<DaemonSessionState> {
    if (this.sessionManager) {
      const session = this.sessionManager.get(sessionId);
      return {
        ...session.getState(),
        revision: session.getStateRevision(),
      };
    }
    return await this.daemonClient!.getSessionState(sessionId);
  }

  async getStateRevision(sessionId: string): Promise<number> {
    if (this.sessionManager) {
      return this.sessionManager.get(sessionId).getStateRevision();
    }
    return (await this.daemonClient!.getSessionState(sessionId)).revision;
  }

  async waitForStateChangeSince(
    sessionId: string,
    revision: number,
    timeoutMs = 250,
  ): Promise<boolean> {
    if (this.sessionManager) {
      return await this.sessionManager.waitForStateChangeSince(
        sessionId,
        revision,
        timeoutMs,
      );
    }

    const result = await this.daemonClient!.waitForStateChange(
      sessionId,
      revision,
      timeoutMs,
    );
    return result.changed;
  }

  async getCachedSnapshot(
    sessionId: string,
    freshness: CachedSnapshotFreshness = "fresh",
  ) {
    if (this.sessionManager) {
      const session = this.sessionManager.get(sessionId);
      return freshness === "fresh"
        ? session.getFreshSnapshot()
        : session.getLastSnapshot();
    }

    return await this.daemonClient!.getCachedSnapshot(sessionId, freshness);
  }

  async sendSocketMessage<T extends BrowserRequestType>(
    type: T,
    payload: BrowserRequestMap[T]["payload"],
    options: { timeoutMs?: number } = { timeoutMs: 30000 },
    sessionId: string,
  ) {
    if (this.sessionManager) {
      return await this.sessionManager
        .get(sessionId)
        .sendSocketMessage(type, payload, options);
    }

    return await this.daemonClient!.sendTabductorRequest(
      sessionId,
      type,
      payload,
      options.timeoutMs,
    );
  }

  async subscribeToTabductorNotifications(
    sessionId: string,
    listener: BrowserSessionNotificationListener,
  ): Promise<() => Promise<void>> {
    if (this.sessionManager) {
      const unsubscribe = this.sessionManager
        .get(sessionId)
        .subscribeToNotifications(listener);
      return async () => {
        unsubscribe();
      };
    }

    return await this.daemonClient!.subscribeToTabductorNotifications(
      sessionId,
      listener,
    );
  }

  async close() {
    if (this.sessionManager) {
      await this.sessionManager.closeAll();
      return;
    }

    await this.daemonClient?.close();
  }
}

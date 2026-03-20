import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { RawData, WebSocket } from "ws";

import { mcpConfig } from "@/config";
import type {
  DaemonNotificationEnvelope,
  DaemonNotificationType,
  DaemonRequestEnvelope,
  DaemonRequestMap,
  DaemonRequestType,
  DaemonResponseEnvelope,
  DaemonSessionState,
} from "@/daemon/protocol";
import type {
  BrowserNotificationMap,
  BrowserNotificationType,
  BrowserRequestMap,
  BrowserRequestType,
  BrowserSnapshotResponse,
} from "@/protocol/messages";
import { logException, logInfo } from "@/utils/log";
import { wait } from "@/utils/async";
import { isPortInUse } from "@/utils/port";

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type TabductorNotificationListener = (
  event: BrowserNotificationType,
  payload: BrowserNotificationMap[BrowserNotificationType]["payload"],
) => void;

type ParsedDaemonMessage =
  | {
      kind: "response";
      message: DaemonResponseEnvelope;
    }
  | {
      kind: "notification";
      message: DaemonNotificationEnvelope;
    }
  | null;

function parseMessage(raw: RawData): ParsedDaemonMessage {
  const text =
    typeof raw === "string"
      ? raw
      : Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : raw.toString();

  try {
    const message = JSON.parse(text) as
      | DaemonNotificationEnvelope
      | DaemonResponseEnvelope;
    if ("event" in message) {
      return {
        kind: "notification",
        message,
      };
    }
    if ("id" in message && "ok" in message) {
      return {
        kind: "response",
        message,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function daemonUrl() {
  return `ws://${mcpConfig.defaultHost}:${mcpConfig.defaultControlPort}`;
}

async function openClientSocket(timeoutMs = 1000): Promise<WebSocket> {
  const url = daemonUrl();

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Timed out connecting to Tabductor daemon at ${url}`));
    }, timeoutMs);

    ws.once("open", () => {
      clearTimeout(timeout);
      resolve(ws);
    });

    ws.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    ws.once("close", () => {
      clearTimeout(timeout);
      reject(new Error(`Tabductor daemon is not reachable at ${url}`));
    });
  });
}

function spawnDaemonProcess() {
  const runtime = process.argv[0];
  const entrypoint = process.argv[1];

  if (!runtime || !entrypoint) {
    throw new Error("Cannot determine how to launch the Tabductor daemon");
  }

  logInfo("daemon.lifecycle", "Spawning Tabductor daemon", {
    entrypoint,
    runtime,
  });
  const child = spawn(runtime, [entrypoint, "daemon"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

async function ensureDaemonAvailable() {
  try {
    const socket = await openClientSocket();
    logInfo("daemon.lifecycle", "Connected to existing Tabductor daemon");
    return socket;
  } catch (_error) {
    if (!(await isPortInUse(mcpConfig.defaultControlPort))) {
      spawnDaemonProcess();
    }

    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const socket = await openClientSocket(500);
        logInfo("daemon.lifecycle", "Connected to Tabductor daemon after retry", {
          attempt: attempt + 1,
        });
        return socket;
      } catch (_retryError) {
        await wait(250);
      }
    }

    throw new Error(
      `Tabductor daemon did not become ready on ws://${mcpConfig.defaultHost}:${mcpConfig.defaultControlPort}`,
    );
  }
}

export class DaemonClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly tabductorNotificationListeners = new Map<
    string,
    Set<TabductorNotificationListener>
  >();

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (raw) => {
      const parsed = parseMessage(raw);
      if (!parsed) {
        return;
      }

      if (parsed.kind === "notification") {
        this.handleNotification(parsed.message);
        return;
      }

      const message = parsed.message;

      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timeout);
      this.pending.delete(message.id);

      if (message.ok) {
        logInfo("daemon.responses", "Daemon response received", {
          id: message.id,
          result: message.result,
        });
        pending.resolve(message.result);
        return;
      }

      logInfo("daemon.errors", "Daemon response returned error", {
        error: message.error,
        id: message.id,
      });
      pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
    });

    const failAll = (reason: string) => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(reason));
        this.pending.delete(id);
      }
    };

    ws.on("close", () => {
      logInfo("daemon.lifecycle", "Tabductor daemon connection closed");
      failAll("Tabductor daemon connection closed");
    });
    ws.on("error", (error) => {
      logException("daemon.errors", "Tabductor daemon connection error", error);
      failAll(`Tabductor daemon connection error: ${error.message}`);
    });
  }

  static async connect(): Promise<DaemonClient> {
    return new DaemonClient(await ensureDaemonAvailable());
  }

  async close() {
    if (this.ws.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        this.ws.close();
        this.ws.once("close", () => resolve());
      });
    }
  }

  async listSessions(): Promise<DaemonSessionState[]> {
    const result = await this.send("list_sessions", {});
    return result.sessions;
  }

  async getSessionState(sessionId: string): Promise<DaemonSessionState> {
    const result = await this.send("get_session_state", { sessionId });
    return result.session;
  }

  async waitForStateChange(
    sessionId: string,
    revision: number,
    timeoutMs?: number,
  ): Promise<{ changed: boolean; session: DaemonSessionState }> {
    return await this.send("wait_for_state_change", {
      revision,
      sessionId,
      timeoutMs,
    });
  }

  async getCachedSnapshot(
    sessionId: string,
    freshness: "current" | "fresh" = "fresh",
  ): Promise<BrowserSnapshotResponse | null> {
    const result = await this.send("get_cached_snapshot", {
      freshness,
      sessionId,
    });
    return result.snapshot;
  }

  async sendTabductorRequest<T extends BrowserRequestType>(
    sessionId: string,
    type: T,
    payload: BrowserRequestMap[T]["payload"],
    timeoutMs?: number,
  ): Promise<BrowserRequestMap[T]["result"]> {
    const result = await this.send("send_tabductor_request", {
      sessionId,
      timeoutMs,
      type,
      payload,
    });
    return result.result as BrowserRequestMap[T]["result"];
  }

  async subscribeToTabductorNotifications(
    sessionId: string,
    listener: TabductorNotificationListener,
  ): Promise<() => Promise<void>> {
    const listeners =
      this.tabductorNotificationListeners.get(sessionId) ??
      new Set<TabductorNotificationListener>();
    const firstListener = listeners.size === 0;
    listeners.add(listener);
    this.tabductorNotificationListeners.set(sessionId, listeners);

    if (firstListener) {
      await this.send("subscribe_tabductor_notifications", { sessionId });
    }

    return async () => {
      const current = this.tabductorNotificationListeners.get(sessionId);
      if (!current) {
        return;
      }
      current.delete(listener);
      if (current.size > 0) {
        return;
      }
      this.tabductorNotificationListeners.delete(sessionId);
      if (this.ws.readyState === WebSocket.OPEN) {
        await this.send("unsubscribe_tabductor_notifications", {
          sessionId,
        }).catch(() => undefined);
      }
    };
  }

  private async send<T extends DaemonRequestType>(
    method: T,
    params: DaemonRequestMap[T]["params"],
    timeoutMs = 30000,
  ): Promise<DaemonRequestMap[T]["result"]> {
    const id = randomUUID();
    const message: DaemonRequestEnvelope<T> = {
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        logInfo("daemon.errors", "Timed out waiting for daemon response", {
          id,
          method,
          timeoutMs,
        });
        reject(new Error(`Timed out waiting for Tabductor daemon method ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
      logInfo("daemon.requests", "Sending daemon request", {
        id,
        method,
        params,
        timeoutMs,
      });
      this.ws.send(JSON.stringify(message), (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timeout);
        this.pending.delete(id);
        logException("daemon.errors", "Failed to send daemon request", error, {
          id,
          method,
          params,
        });
        reject(error);
      });
    }) as Promise<DaemonRequestMap[T]["result"]>;
  }

  private handleNotification(message: DaemonNotificationEnvelope<DaemonNotificationType>) {
    if (message.event !== "tabductor_notification") {
      return;
    }

    const listeners = this.tabductorNotificationListeners.get(message.params.sessionId);
    if (!listeners?.size) {
      return;
    }

    for (const listener of listeners) {
      listener(message.params.event, message.params.payload);
    }
  }
}

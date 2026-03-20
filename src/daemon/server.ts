import { RawData, WebSocket, WebSocketServer } from "ws";

import { mcpConfig } from "@/config";
import { Context } from "@/context";
import type {
  DaemonNotificationEnvelope,
  DaemonRequestEnvelope,
  DaemonResponseEnvelope,
  DaemonRequestType,
} from "@/daemon/protocol";
import type {
  BrowserNotificationMap,
  BrowserNotificationType,
} from "@/protocol/messages";
import { logException, logInfo } from "@/utils/log";
import { createWebSocketServer } from "@/ws";

function parseRequest(raw: RawData): DaemonRequestEnvelope | null {
  const text =
    typeof raw === "string"
      ? raw
      : Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : raw.toString();

  try {
    const message = JSON.parse(text) as DaemonRequestEnvelope;
    if ("id" in message && "method" in message) {
      return message;
    }
    return null;
  } catch {
    return null;
  }
}

function sendResponse(ws: WebSocket, message: DaemonResponseEnvelope) {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(message));
}

function sendNotification(ws: WebSocket, message: DaemonNotificationEnvelope) {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(message));
}

async function handleRequest(
  context: Context,
  request: DaemonRequestEnvelope,
): Promise<DaemonResponseEnvelope> {
  logInfo("daemon.requests", "Handling daemon request", {
    id: request.id,
    method: request.method,
    params: request.params,
  });
  try {
    switch (request.method as DaemonRequestType) {
      case "list_sessions": {
        return {
          id: request.id,
          ok: true,
          result: {
            sessions: await context.listSessionsWithRevision(),
          },
        };
      }
      case "get_session_state": {
        const params = request.params as {
          sessionId: string;
        };
        return {
          id: request.id,
          ok: true,
          result: {
            session: await context.getSessionStateWithRevision(
              params.sessionId,
            ),
          },
        };
      }
      case "wait_for_state_change": {
        const params = request.params as {
          sessionId: string;
          revision: number;
          timeoutMs?: number;
        };
        const changed = await context.waitForStateChangeSince(
          params.sessionId,
          params.revision,
          params.timeoutMs,
        );
        return {
          id: request.id,
          ok: true,
          result: {
            changed,
            session: await context.getSessionStateWithRevision(
              params.sessionId,
            ),
          },
        };
      }
      case "get_cached_snapshot": {
        const params = request.params as {
          sessionId: string;
          freshness?: "current" | "fresh";
        };
        return {
          id: request.id,
          ok: true,
          result: {
            snapshot: await context.getCachedSnapshot(
              params.sessionId,
              params.freshness ?? "fresh",
            ),
          },
        };
      }
      case "send_tabductor_request": {
        const params = request.params as {
          sessionId: string;
          type: string;
          payload: unknown;
          timeoutMs?: number;
        };
        return {
          id: request.id,
          ok: true,
          result: {
            result: await context.sendSocketMessage(
              params.type as never,
              params.payload as never,
              params.timeoutMs
                ? { timeoutMs: params.timeoutMs }
                : undefined,
              params.sessionId,
            ),
          },
        };
      }
      case "subscribe_tabductor_notifications":
      case "unsubscribe_tabductor_notifications":
        return {
          id: request.id,
          ok: true,
          result: {
            acknowledged: true,
          },
        };
      default:
        throw new Error(`Unsupported daemon method: ${request.method}`);
    }
  } catch (error) {
    logException("daemon.errors", "Daemon request failed", error, {
      id: request.id,
      method: request.method,
      params: request.params,
    });
    return {
      id: request.id,
      ok: false,
      error: {
        code: "DAEMON_ERROR",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function createControlServer(): Promise<WebSocketServer> {
  return new WebSocketServer({
    host: mcpConfig.defaultHost,
    port: mcpConfig.defaultControlPort,
  });
}

export async function startDaemonRuntime() {
  const context = Context.createLocal();
  const controlClientSubscriptions = new Map<WebSocket, Set<string>>();

  const forwardBrowserNotification = (
    sessionId: string,
    event: BrowserNotificationType,
    payload: BrowserNotificationMap[BrowserNotificationType]["payload"],
  ) => {
    for (const [client, subscriptions] of controlClientSubscriptions) {
      if (!subscriptions.has(sessionId)) {
        continue;
      }
      sendNotification(client, {
        event: "tabductor_notification",
        params: {
          sessionId,
          event,
          payload,
        },
      });
    }
  };

  const browserWss = await createWebSocketServer(
    mcpConfig.defaultWsPort,
    mcpConfig.defaultHost,
  );
  logInfo("daemon.lifecycle", "Tabductor daemon browser websocket ready", {
    host: mcpConfig.defaultHost,
    port: mcpConfig.defaultWsPort,
  });
  browserWss.on("connection", (websocket) => {
    logInfo("daemon.lifecycle", "Browser extension connected to daemon");
    const session = context.addSession(websocket);
    session.subscribeToNotifications((event, payload) => {
      forwardBrowserNotification(session.id, event, payload);
    });
  });

  const controlWss = await createControlServer();
  logInfo("daemon.lifecycle", "Tabductor daemon control websocket ready", {
    host: mcpConfig.defaultHost,
    port: mcpConfig.defaultControlPort,
  });
  controlWss.on("connection", (ws) => {
    logInfo("daemon.lifecycle", "Daemon control client connected");
    controlClientSubscriptions.set(ws, new Set());
    ws.on("message", async (raw) => {
      const request = parseRequest(raw);
      if (!request) {
        logInfo("daemon.errors", "Ignoring invalid daemon request payload");
        return;
      }

      if (request.method === "subscribe_tabductor_notifications") {
        controlClientSubscriptions.get(ws)?.add(
          (request.params as { sessionId: string }).sessionId,
        );
      }

      if (request.method === "unsubscribe_tabductor_notifications") {
        controlClientSubscriptions.get(ws)?.delete(
          (request.params as { sessionId: string }).sessionId,
        );
      }

      const response = await handleRequest(context, request);
      logInfo("daemon.responses", "Daemon response ready", {
        id: response.id,
        ok: response.ok,
        response,
      });
      sendResponse(ws, response);
    });
    ws.on("close", () => {
      controlClientSubscriptions.delete(ws);
    });
  });

  const close = async () => {
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        controlWss.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
      new Promise<void>((resolve, reject) => {
        browserWss.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
      context.close(),
    ]);
  };

  const shutdown = async () => {
    try {
      logInfo("daemon.lifecycle", "Shutting down Tabductor daemon");
      await close();
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

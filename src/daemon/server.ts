import { RawData, WebSocket, WebSocketServer } from "ws";

import { mcpConfig } from "@/config";
import { Context } from "@/context";
import type {
  DaemonRequestEnvelope,
  DaemonResponseEnvelope,
  DaemonRequestType,
} from "@/daemon/protocol";
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

async function handleRequest(
  context: Context,
  request: DaemonRequestEnvelope,
): Promise<DaemonResponseEnvelope> {
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
      case "send_browser_request": {
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
      default:
        throw new Error(`Unsupported daemon method: ${request.method}`);
    }
  } catch (error) {
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

  const browserWss = await createWebSocketServer(
    mcpConfig.defaultWsPort,
    mcpConfig.defaultHost,
  );
  browserWss.on("connection", (websocket) => {
    context.addSession(websocket);
  });

  const controlWss = await createControlServer();
  controlWss.on("connection", (ws) => {
    ws.on("message", async (raw) => {
      const request = parseRequest(raw);
      if (!request) {
        return;
      }

      const response = await handleRequest(context, request);
      sendResponse(ws, response);
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
      await close();
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

import { randomUUID } from "node:crypto";

import { RawData, WebSocket } from "ws";

import {
  BrowserNotificationMap,
  BrowserNotificationType,
  BrowserRequestMap,
  BrowserRequestType,
  RpcErrorEnvelope,
  RpcNotificationEnvelope,
  RpcRequestEnvelope,
  RpcResponseEnvelope,
} from "@/protocol/messages";

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timeout: NodeJS.Timeout;
};

type ParsedInboundMessage =
  | {
      kind: "response";
      message: RpcResponseEnvelope;
    }
  | {
      kind: "notification";
      message: RpcNotificationEnvelope;
    }
  | null;

function parseMessage(raw: RawData): ParsedInboundMessage {
  const text =
    typeof raw === "string"
      ? raw
      : Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : raw.toString();

  try {
    const message = JSON.parse(text) as
      | RpcResponseEnvelope
      | RpcNotificationEnvelope;
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

function formatRpcError(error: RpcErrorEnvelope["error"]): Error {
  const message = error.code ? `${error.code}: ${error.message}` : error.message;
  return new Error(message);
}

export function createRpcClient(
  ws: WebSocket,
  callbacks?: {
    onNotification?: <T extends BrowserNotificationType>(
      event: T,
      payload: BrowserNotificationMap[T]["payload"],
    ) => void;
  },
) {
  const pending = new Map<string, PendingRequest>();

  const failAll = (reason: string) => {
    for (const [id, request] of pending) {
      clearTimeout(request.timeout);
      request.reject(new Error(reason));
      pending.delete(id);
    }
  };

  ws.on("message", (raw) => {
    const parsed = parseMessage(raw);
    if (!parsed) {
      return;
    }

    if (parsed.kind === "notification") {
      callbacks?.onNotification?.(
        parsed.message.event,
        parsed.message.payload as never,
      );
      return;
    }

    const message = parsed.message;
    const request = pending.get(message.id);
    if (!request) {
      return;
    }

    clearTimeout(request.timeout);
    pending.delete(message.id);

    if (message.ok) {
      request.resolve(message.result);
      return;
    }

    request.reject(formatRpcError(message.error));
  });

  ws.on("close", () => {
    failAll("WebSocket closed");
  });

  ws.on("error", (error) => {
    failAll(`WebSocket error: ${error.message}`);
  });

  async function sendRequest<T extends BrowserRequestType>(
    type: T,
    payload: BrowserRequestMap[T]["payload"],
    options: { timeoutMs?: number } = {},
  ): Promise<BrowserRequestMap[T]["result"]> {
    const id = randomUUID();
    const timeoutMs = options.timeoutMs ?? 30000;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for response to ${type}`));
      }, timeoutMs);

      pending.set(id, {
        resolve: (value) => resolve(value as BrowserRequestMap[T]["result"]),
        reject,
        timeout,
      });

      const message: RpcRequestEnvelope<T> = { id, type, payload };
      ws.send(JSON.stringify(message), (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timeout);
        pending.delete(id);
        reject(error);
      });
    });
  }

  return {
    sendRequest,
  };
}

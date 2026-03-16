import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { RawData, WebSocket } from "ws";

import { mcpConfig } from "@/config";
import type {
  DaemonRequestEnvelope,
  DaemonRequestMap,
  DaemonRequestType,
  DaemonResponseEnvelope,
  DaemonSessionState,
} from "@/daemon/protocol";
import type {
  BrowserRequestMap,
  BrowserRequestType,
  BrowserSnapshotResponse,
} from "@/protocol/messages";
import { wait } from "@/utils/async";
import { isPortInUse } from "@/utils/port";

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

function parseResponse(raw: RawData): DaemonResponseEnvelope | null {
  const text =
    typeof raw === "string"
      ? raw
      : Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : raw.toString();

  try {
    const message = JSON.parse(text) as DaemonResponseEnvelope;
    if ("id" in message && "ok" in message) {
      return message;
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
      reject(new Error(`Timed out connecting to Browser MCP daemon at ${url}`));
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
      reject(new Error(`Browser MCP daemon is not reachable at ${url}`));
    });
  });
}

function spawnDaemonProcess() {
  const runtime = process.argv[0];
  const entrypoint = process.argv[1];

  if (!runtime || !entrypoint) {
    throw new Error("Cannot determine how to launch the Browser MCP daemon");
  }

  const child = spawn(runtime, [entrypoint, "daemon"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

async function ensureDaemonAvailable() {
  try {
    return await openClientSocket();
  } catch (_error) {
    if (!(await isPortInUse(mcpConfig.defaultControlPort))) {
      spawnDaemonProcess();
    }

    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        return await openClientSocket(500);
      } catch (_retryError) {
        await wait(250);
      }
    }

    throw new Error(
      `Browser MCP daemon did not become ready on ws://${mcpConfig.defaultHost}:${mcpConfig.defaultControlPort}`,
    );
  }
}

export class DaemonClient {
  private readonly pending = new Map<string, PendingRequest>();

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (raw) => {
      const message = parseResponse(raw);
      if (!message) {
        return;
      }

      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timeout);
      this.pending.delete(message.id);

      if (message.ok) {
        pending.resolve(message.result);
        return;
      }

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
      failAll("Browser MCP daemon connection closed");
    });
    ws.on("error", (error) => {
      failAll(`Browser MCP daemon connection error: ${error.message}`);
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

  async sendBrowserRequest<T extends BrowserRequestType>(
    sessionId: string,
    type: T,
    payload: BrowserRequestMap[T]["payload"],
    timeoutMs?: number,
  ): Promise<BrowserRequestMap[T]["result"]> {
    const result = await this.send("send_browser_request", {
      sessionId,
      timeoutMs,
      type,
      payload,
    });
    return result.result as BrowserRequestMap[T]["result"];
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
        reject(new Error(`Timed out waiting for Browser MCP daemon method ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
      this.ws.send(JSON.stringify(message), (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    }) as Promise<DaemonRequestMap[T]["result"]>;
  }
}

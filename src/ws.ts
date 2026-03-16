import { WebSocketServer } from "ws";

import { mcpConfig } from "@/config";

export async function createWebSocketServer(
  port: number = mcpConfig.defaultWsPort,
  host: string = mcpConfig.defaultHost,
): Promise<WebSocketServer> {
  return await new Promise((resolve, reject) => {
    const server = new WebSocketServer({
      host,
      port,
    });
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

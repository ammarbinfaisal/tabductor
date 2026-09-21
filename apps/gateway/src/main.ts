import { createServer, request as proxyRequest } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig } from "@tabductor/core";
import { createDb, browserSessions, browserWorkers } from "@tabductor/db";
import { browserControlIsActive, browserWorkerToken, verifyBrowserViewToken, type BrowserViewClaims } from "@tabductor/engine";
import { and, eq, isNotNull, sql } from "drizzle-orm";
const config = loadConfig();
const key = process.env.BROWSER_WORKER_TOKEN_KEY ?? "";
if (key.length < 32) throw new Error("browser gateway signing key is required");
const handle = createDb(config.DATABASE_URL);
const web = new URL(process.env.BROWSER_WEB_URL ?? "http://127.0.0.1:3000");
const server = createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(200); res.end(); return; }
  const upstream = proxyRequest({ hostname: web.hostname, port: web.port || 80, path: req.url, method: req.method,
    headers: { ...req.headers, "x-forwarded-host": req.headers.host, "x-forwarded-proto": req.headers["x-forwarded-proto"] ?? "http" } }, (response) => {
    res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
  });
  upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.on("aborted", () => upstream.destroy());
  req.pipe(upstream);
});
const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
async function owned(claims: BrowserViewClaims) {
  const [row] = await handle.db.select({ session: browserSessions, worker: browserWorkers }).from(browserSessions)
    .innerJoin(browserWorkers, eq(browserWorkers.id, browserSessions.workerId)).where(and(
      eq(browserSessions.id, claims.sessionId), eq(browserSessions.accountId, claims.accountId), eq(browserSessions.generation, claims.generation)));
  if (!row || !["ready", "running"].includes(row.session.status) || !row.worker.endpointUrl || row.worker.status !== "allocated") throw new Error("session unavailable");
  if (claims.access === "control" && (!browserControlIsActive(row.session) || row.session.inputOwnerGeneration !== claims.inputGeneration)) throw new Error("input ownership revoked");
  return row;
}
server.on("upgrade", (req, socket, head) => {
  void (async () => {
    const protocols = req.headers["sec-websocket-protocol"]?.split(",").map((part) => part.trim()) ?? [];
    const auth = protocols.find((protocol) => protocol.startsWith("td."));
    if (!auth) throw new Error("unauthorized");
    const claims = verifyBrowserViewToken(key, auth.slice(3));
    const { worker, session } = await owned(claims);
    // A short-lived token admits this connection. Profile control then lasts until revoked
    // by session ownership, which is still checked continuously, rather than a timer.
    const profileControl = claims.access === "control" && session.executionId === null;
    sockets.handleUpgrade(req, socket, head, (viewer) => {
      const upstreamUrl = new URL(`/v1/sessions/${encodeURIComponent(claims.sessionId)}/view`, worker.endpointUrl!);
      upstreamUrl.protocol = upstreamUrl.protocol === "https:" ? "wss:" : "ws:";
      upstreamUrl.searchParams.set("generation", String(claims.generation));
      upstreamUrl.searchParams.set("input_generation", String(claims.inputGeneration));
      upstreamUrl.searchParams.set("access", claims.access);
      const upstream = new WebSocket(upstreamUrl, { headers: { authorization: `Bearer ${browserWorkerToken(key, worker.podName)}`, "x-tabductor-rpc-version": "1" }, maxPayload: 16 * 1024 * 1024 });
      const pending: Buffer[] = [];
      let pendingBytes = 0;
      let checking = false;
      const close = () => { viewer.close(); upstream.close(); clearInterval(timer); };
      const timer = setInterval(() => {
        if (checking) return;
        checking = true;
        void owned(claims).then(() => { if (!profileControl && Date.now() >= claims.expiresAt) close(); }).catch(close).finally(() => { checking = false; });
      }, 500);
      upstream.on("open", () => { for (const bytes of pending) upstream.send(bytes); pending.length = 0; });
      viewer.on("message", (data) => {
        if ((!profileControl && Date.now() >= claims.expiresAt) || upstream.bufferedAmount > 1024 * 1024) { close(); return; }
        const bytes = Buffer.from(data as Buffer);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes);
        else if (upstream.readyState === WebSocket.CONNECTING && (pendingBytes += bytes.length) < 64 * 1024) pending.push(bytes);
        else close();
      });
      upstream.on("message", (data) => { if (viewer.readyState === WebSocket.OPEN && viewer.bufferedAmount < 16 * 1024 * 1024) viewer.send(data, { binary: true }); else close(); });
      upstream.on("error", close); viewer.on("error", close); upstream.on("close", close);
      viewer.on("close", () => {
        close();
        if (claims.access === "control") void handle.db.update(browserSessions).set({ inputOwner: "paused", inputOwnerGeneration: sql`${browserSessions.inputOwnerGeneration} + 1` })
          .where(and(eq(browserSessions.id, claims.sessionId), isNotNull(browserSessions.executionId), eq(browserSessions.inputOwner, "human"), eq(browserSessions.inputOwnerGeneration, claims.inputGeneration)))
          .catch(() => {});
      });
    });
  })().catch(() => { socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); socket.destroy(); });
});
server.listen(Number(process.env.PORT ?? 8081), "0.0.0.0");
async function shutdown() { for (const socket of sockets.clients) socket.terminate(); sockets.close(); server.close(); await handle.close(); }
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

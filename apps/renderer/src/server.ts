import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "@tabductor/core";
import { z } from "zod";
import { runInSandbox, type SandboxConfig } from "./sandbox.js";

/**
 * The renderer's HTTP surface (S5e deliverable 1) — one route, `POST /render`. Deliberately
 * thin: no job-queue abstraction beyond the concurrency semaphore below (style constraint:
 * "no render-job queue abstraction beyond what apps/renderer's own HTTP surface needs").
 * `packages/assets/src/render-client.ts` is the only intended caller; this app never touches
 * Postgres, `BlobStore`, or the asset store — every byte in a request is already resolved by
 * the caller (S5e deliverable 2's "the host resolves images before compilation").
 */

const REQUEST_SCHEMA = z.object({
  format: z.enum(["pdf", "deck"]),
  texSource: z.string().min(1),
  files: z.array(z.object({ filename: z.string().min(1), contentBase64: z.string() })).max(20).default([]),
});

export type RendererServer = { url: string; close: () => Promise<void> };

export type RendererServerDeps = {
  sandbox: SandboxConfig;
  logger: Logger;
  /** A render is a whole `docker run`; this bounds how many run at once rather than letting
   * an unbounded request rate fan out an unbounded number of containers. */
  maxConcurrent?: number;
  /** 0 = OS-assigned ephemeral port (what tests use); a real deployment sets one explicitly. */
  port?: number;
  host?: string;
};

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw === "" ? {} : JSON.parse(raw);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startRendererServer(deps: RendererServerDeps): Promise<RendererServer> {
  const maxConcurrent = deps.maxConcurrent ?? 4;
  let inFlight = 0;
  const waiters: (() => void)[] = [];

  async function acquireSlot(): Promise<void> {
    if (inFlight < maxConcurrent) {
      inFlight++;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    inFlight++;
  }
  function releaseSlot(): void {
    inFlight--;
    const next = waiters.shift();
    if (next) next();
  }

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/render") {
      sendJson(res, 404, { ok: false, kind: "compile_error", log: "not found" });
      return;
    }

    void (async () => {
      let rawBody: unknown;
      try {
        rawBody = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { ok: false, kind: "compile_error", log: `invalid request body: ${String(err)}` });
        return;
      }
      const parsed = REQUEST_SCHEMA.safeParse(rawBody);
      if (!parsed.success) {
        sendJson(res, 400, { ok: false, kind: "compile_error", log: `invalid request: ${parsed.error.message}` });
        return;
      }

      await acquireSlot();
      try {
        const outcome = await runInSandbox(deps.sandbox, {
          texSource: parsed.data.texSource,
          files: parsed.data.files.map((f) => ({
            filename: f.filename,
            bytes: Buffer.from(f.contentBase64, "base64"),
          })),
        });
        if (outcome.ok) {
          sendJson(res, 200, { ok: true, pdfBase64: outcome.pdf.toString("base64") });
        } else {
          sendJson(res, 200, outcome);
        }
      } catch (err) {
        deps.logger.error("render failed", { error: err instanceof Error ? err.message : String(err) });
        sendJson(res, 500, { ok: false, kind: "compile_error", log: "internal renderer error" });
      } finally {
        releaseSlot();
      }
    })();
  });

  return new Promise((resolve) => {
    server.listen(deps.port ?? 0, deps.host ?? "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://${deps.host ?? "127.0.0.1"}:${port}`,
        close: () => new Promise<void>((res2) => server.close(() => res2())),
      });
    });
  });
}

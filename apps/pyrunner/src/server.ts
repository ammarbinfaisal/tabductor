import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "@tabductor/core";
import { z } from "zod";
import { runJob, type JobConfig } from "./job.js";

/**
 * The pyrunner's HTTP surface — `POST /run` and `GET /status`. Same shape as
 * `apps/renderer/src/server.ts`, down to the concurrency semaphore, and thin for the same
 * reason: no job-queue abstraction beyond what this surface needs.
 *
 * `/status` is the one addition, and it earns its place: unlike the renderer, this app *is* in
 * `docker-compose.yml`, so compose's healthcheck and `engine`'s
 * `depends_on: {pyrunner: {condition: service_healthy}}` need something to ask.
 *
 * This app never touches Postgres, the blob store or the asset store. Every byte in a request
 * is already resolved by the caller, and every byte in the response is validated by it —
 * `packages/engine/src/python-executor.ts` is the only intended client.
 */

const RUN_REQUEST = z.object({
  code: z.string().min(1).max(200_000),
  /** Written verbatim to `in/trigger.json`; `null` for a run with no trigger. */
  trigger: z.unknown(),
  assets: z
    .array(
      z.object({
        // Bare names only. The executor derives these with `basename`, and this is the
        // second check rather than the first — the same posture render.ts takes.
        filename: z.string().min(1).regex(/^[\w.-]+$/, "filename must be a bare name"),
        contentBase64: z.string(),
      }),
    )
    .max(32)
    .default([]),
  sourceDateEpoch: z.number().int().nonnegative(),
  /** Per-task override; the server clamps it to its own configured ceiling. */
  wallClockMs: z.number().int().positive().optional(),
});

export type PyrunnerServer = { url: string; close: () => Promise<void> };

export type PyrunnerServerDeps = {
  job: JobConfig;
  logger: Logger;
  /** A job is a whole process; this bounds how many run at once. */
  maxConcurrent?: number;
  /** 0 = OS-assigned ephemeral port (what tests use); a deployment sets one explicitly. */
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

function badRequest(res: http.ServerResponse, message: string): void {
  sendJson(res, 400, { ok: false, kind: "program_error", exitCode: -1, stdout: "", stderr: message, durationMs: 0 });
}

export function startPyrunnerServer(deps: PyrunnerServerDeps): Promise<PyrunnerServer> {
  const maxConcurrent = deps.maxConcurrent ?? 2;
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
    if (req.method === "GET" && req.url === "/status") {
      sendJson(res, 200, { ok: true, inFlight, maxConcurrent });
      return;
    }
    if (req.method !== "POST" || req.url !== "/run") {
      badRequest(res, "not found");
      return;
    }

    void (async () => {
      let rawBody: unknown;
      try {
        rawBody = await readJsonBody(req);
      } catch (err) {
        badRequest(res, `invalid request body: ${String(err)}`);
        return;
      }
      const parsed = RUN_REQUEST.safeParse(rawBody);
      if (!parsed.success) {
        badRequest(res, `invalid request: ${parsed.error.message}`);
        return;
      }

      await acquireSlot();
      try {
        const outcome = await runJob(deps.job, {
          code: parsed.data.code,
          trigger: parsed.data.trigger ?? null,
          assets: parsed.data.assets.map((a) => ({
            filename: a.filename,
            bytes: Buffer.from(a.contentBase64, "base64"),
          })),
          sourceDateEpoch: parsed.data.sourceDateEpoch,
          wallClockMs: parsed.data.wallClockMs,
        });
        sendJson(res, 200, outcome);
      } catch (err) {
        deps.logger.error("job failed", { error: err instanceof Error ? err.message : String(err) });
        sendJson(res, 500, {
          ok: false,
          kind: "program_error",
          exitCode: -1,
          stdout: "",
          stderr: "internal pyrunner error",
          durationMs: 0,
        });
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

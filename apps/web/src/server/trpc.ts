import { AppError } from "@tabductor/core";
import type { Db } from "@tabductor/db";
import { findShareByToken, publicEventTypes, refCodec, type PublicRead } from "@tabductor/engine";
import type { Metrics } from "@tabductor/telemetry";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { z } from "zod";
import { db } from "./db.js";
import { createRateLimiter } from "./rate-limit.js";

export type Context = {
  db: Db;
  /**
   * Who is asking, for rate-limiting purposes — an IP-derived string, supplied by whatever
   * composition point has a request in hand (the HTTP route, a server component). Absent
   * for in-process callers such as the system tests, which are not a public surface.
   */
  clientKey?: string;
  /** Injected, never imported: §17.2 rule 1 keeps the SDK at composition roots. */
  metrics?: Metrics;
};

export function createContext(): Context {
  return { db: db() };
}

/**
 * Single-user local install (S2c: "no auth in this subphase"). Every row still carries a
 * user id because §14 says it does and retrofitting one later is a migration; this is the
 * value it carries until authentication exists.
 */
export const LOCAL_USER = "user_local";

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  /**
   * `AppError.details` rides out on `error.data.appError`, which is how the graph editor
   * puts "a schedule may not bind to an asset task" on the offending node instead of in a
   * toast (U0). Anything else keeps the default shape.
   */
  errorFormatter({ shape, error }) {
    const cause = error.cause;
    if (!(cause instanceof AppError)) return shape;
    return { ...shape, data: { ...shape.data, appError: { code: cause.code, details: cause.details } } };
  },
});

/** Codes the packages raise that are a missing row rather than a bad request. */
const NOT_FOUND = new Set([
  "workflow_not_found",
  "version_not_found",
  "task_not_found",
  "run_not_found",
  "share_not_found",
]);

/**
 * Domain errors are the packages' to define and this layer's to classify. Without it every
 * `AppError` — a graph that fails its checks, a workflow id that does not exist — would
 * surface as a 500, and the client could not tell "you sent something wrong" from "we
 * broke".
 */
const domainErrors = t.middleware(async ({ next }) => {
  // tRPC hands a failed resolver back as `{ ok: false, error }` rather than throwing, so
  // this inspects the result; a try/catch here would never fire.
  const result = await next();
  if (result.ok) return result;

  const cause = result.error.cause;
  if (!(cause instanceof AppError)) return result;
  throw new TRPCError({
    code: NOT_FOUND.has(cause.code) ? "NOT_FOUND" : "BAD_REQUEST",
    message: cause.message,
    cause,
  });
});

export const router = t.router;
export const procedure = t.procedure.use(domainErrors);
export const createCallerFactory = t.createCallerFactory;

/**
 * The public read surface's context (S2d, sharing.md §4.2).
 *
 * `shareProcedure` resolves the token to a live share and hands the resolver `{db, view}`
 * and nothing else. `view` is the engine's own `PublicRead` scope — the workflow id, the
 * share-scoped ref codec, and the visibility manifest — so a procedure spreads it whole
 * rather than re-spelling three fields it could spell two of.
 *
 * That scope carries a **required** `workflowId`, which is what keeps this path away from
 * anything shaped like `listWorkflows`: a read whose owner filter is optional and whose only
 * caller omits it, so it returns the whole database.
 */
export type ShareContext = Context & { view: PublicRead };

/**
 * Two buckets. The client one is checked *before* the database lookup, so guessing tokens
 * costs the guesser rather than Postgres; the share one bounds a single link's traffic
 * however many addresses it arrives from.
 */
const clientLimiter = createRateLimiter({ capacity: 120, refillPerSecond: 4 });
const shareLimiter = createRateLimiter({ capacity: 240, refillPerSecond: 8 });

/** Same answer for unknown, revoked and malformed — a distinct one confirms a workflow. */
const shareGone = (): TRPCError => new TRPCError({ code: "NOT_FOUND", message: "no such share" });

/**
 * The token input, declared once. The middleware reads it off the raw input and every public
 * procedure re-declares it as part of its own schema; two declarations would eventually
 * disagree, and the disagreement would look like a token the gate accepts and the procedure
 * rejects — or worse, the reverse.
 */
export const shareTokenSchema = z.object({ token: z.string().min(1).max(200) });

export const shareProcedure = procedure.use(async ({ ctx, next, getRawInput }) => {
  const parsed = shareTokenSchema.safeParse(await getRawInput());
  if (!parsed.success) throw shareGone();

  if (ctx.clientKey && !clientLimiter.take(ctx.clientKey)) {
    ctx.metrics?.shareViews.add("rate_limited");
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "slow down" });
  }

  const share = await findShareByToken(ctx.db, parsed.data.token);
  if (!share) {
    ctx.metrics?.shareViews.add("unknown");
    throw shareGone();
  }
  if (share.revokedAt !== null) {
    // Counted apart from `unknown` — an old link in circulation and someone guessing are
    // different things to an operator — but answered identically.
    ctx.metrics?.shareViews.add("revoked");
    throw shareGone();
  }

  if (!shareLimiter.take(share.id)) {
    ctx.metrics?.shareViews.add("rate_limited");
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "slow down" });
  }

  ctx.metrics?.shareViews.add("ok");
  return next({
    ctx: {
      ...ctx,
      view: {
        workflowId: share.workflowId,
        ref: refCodec(share),
        publicTypes: await publicEventTypes(ctx.db, share.workflowId),
      },
    } satisfies ShareContext,
  });
});

import { AppError } from "@tabductor/core";
import type { Db } from "@tabductor/db";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { db } from "./db.js";

export type Context = { db: Db };

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
const NOT_FOUND = new Set(["workflow_not_found", "version_not_found", "task_not_found", "run_not_found"]);

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

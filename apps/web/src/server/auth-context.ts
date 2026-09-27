import { auth } from "@clerk/nextjs/server";
import { TRPCError } from "@trpc/server";
import { resolveAccountIdentity, resolveAccountMcpToken } from "@tabductor/engine";
import { db } from "./db.js";
import { clerkConfigured } from "./clerk-config.js";
export { clerkConfigured } from "./clerk-config.js";

export const LOCAL_ACCOUNT = "acct_local";

export async function accountIdForWebRequest(): Promise<string> {
  if (!clerkConfigured()) {
    if (process.env.NODE_ENV === "production" && process.env.TABDUCTOR_FIXTURE_MODE !== "1") {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Clerk is not configured" });
    }
    return LOCAL_ACCOUNT;
  }
  const session = await auth();
  if (!session.userId || !session.sessionId) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in required" });
  const accountId = await resolveAccountIdentity(db(), { provider: "clerk", subject: session.userId });
  return accountId;
}

export async function accountIdForMcpRequest(request: Request): Promise<string> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) throw new TRPCError({ code: "UNAUTHORIZED", message: "MCP bearer token required" });
  const accountId = await resolveAccountMcpToken(db(), match[1]!);
  if (!accountId) throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid or revoked MCP token" });
  return accountId;
}

import { auth } from "@clerk/nextjs/server";
import { TRPCError } from "@trpc/server";
import { resolveAccountIdentity, resolveAccountMcpToken } from "@tabductor/engine";
import { db } from "./db.js";

export const LOCAL_ACCOUNT = "acct_local";

export function clerkConfigured(): boolean {
  return Boolean(process.env.CLERK_SECRET_KEY && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
}

export async function accountIdForWebRequest(): Promise<string> {
  if (!clerkConfigured()) {
    if (process.env.NODE_ENV === "production" && process.env.TABDUCTOR_FIXTURE_MODE !== "1") {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Clerk is not configured" });
    }
    return LOCAL_ACCOUNT;
  }
  const session = await auth();
  if (!session.userId) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in required" });
  return resolveAccountIdentity(db(), { provider: "clerk", subject: session.userId });
}

export async function accountIdForMcpRequest(request: Request): Promise<string> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) throw new TRPCError({ code: "UNAUTHORIZED", message: "MCP bearer token required" });
  const accountId = await resolveAccountMcpToken(db(), match[1]!);
  if (!accountId) throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid or revoked MCP token" });
  return accountId;
}

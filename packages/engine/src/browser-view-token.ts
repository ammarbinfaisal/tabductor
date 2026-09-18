import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@tabductor/core";
import { z } from "zod";
const schema = z.object({ accountId: z.string().min(1), sessionId: z.string().min(1), generation: z.number().int().positive(),
  inputGeneration: z.number().int().positive(), access: z.enum(["view", "control"]), expiresAt: z.number().int().positive() }).strict();
export type BrowserViewClaims = z.infer<typeof schema>;
function signature(key: string, payload: string) {
  if (key.length < 32) throw new AppError("browser_gateway_unconfigured", "browser gateway signing key is missing");
  return createHmac("sha256", key).update(`browser-view:${payload}`).digest("base64url");
}
export function mintBrowserViewToken(key: string, claims: BrowserViewClaims): string {
  const payload = Buffer.from(JSON.stringify(schema.parse(claims))).toString("base64url");
  return `${payload}.${signature(key, payload)}`;
}
export function verifyBrowserViewToken(key: string, token: string, now = Date.now()): BrowserViewClaims {
  try {
    if (token.length > 2048) throw new Error();
    const parts = token.split(".");
    if (parts.length !== 2) throw new Error();
    const expected = Buffer.from(signature(key, parts[0]!));
    const actual = Buffer.from(parts[1]!);
    if (expected.length !== actual.length || !timingSafeEqual(actual, expected)) throw new Error();
    const claims = schema.parse(JSON.parse(Buffer.from(parts[0]!, "base64url").toString()));
    if (claims.expiresAt <= now || claims.expiresAt > now + 120_000) throw new Error();
    return claims;
  } catch { throw new AppError("browser_view_token_invalid", "browser access token is invalid or expired"); }
}

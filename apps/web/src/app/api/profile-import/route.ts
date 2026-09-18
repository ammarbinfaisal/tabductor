import { importProfileAuth } from "@tabductor/engine";
import { AppError, loadConfig } from "@tabductor/core";
import { configuredKeyWrapper } from "@tabductor/secrets";
import { db } from "../../../server/db.js";
export const runtime = "nodejs";
function cors(request: Request) {
  const origin = request.headers.get("origin") ?? "";
  return { "Cache-Control": "no-store", Vary: "Origin", ...(/^chrome-extension:\/\/[a-p]{32}$/.test(origin) ? { "Access-Control-Allow-Origin": origin } : {}) };
}
export function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: { ...cors(request), "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, content-type" } });
}
export async function POST(request: Request) {
  const headers = cors(request);
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) return Response.json({ error: "A profile import code is required" }, { status: 401, headers });
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: "Missing import data" }, { status: 400, headers });
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 12 * 1024 * 1024) { await reader.cancel(); return Response.json({ error: "Website state exceeds 12 MiB" }, { status: 413, headers }); }
      chunks.push(part.value);
    }
    const body = Buffer.concat(chunks);
    try {
      const result = await importProfileAuth(db(), configuredKeyWrapper(loadConfig()), token, JSON.parse(body.toString()));
      return Response.json(result, { headers });
    } finally { body.fill(0); }
  } catch (error) {
    const known = error instanceof AppError && ["profile_import_invalid", "profile_in_use", "profile_auth_invalid", "profile_auth_too_large"].includes(error.code);
    return Response.json({ error: known ? error.message : "Could not import website authentication" }, { status: error instanceof AppError && error.code === "profile_in_use" ? 409 : 400, headers });
  } finally { for (const chunk of chunks) chunk.fill(0); reader.releaseLock(); }
}

import { loadConfig } from "@tabductor/core";
import { configuredBlobStore } from "@tabductor/browser/blob-store";
import { configuredKeyWrapper } from "@tabductor/secrets";
import { readBrowserMedia } from "@tabductor/engine";
import { db } from "../../../../../../server/db.js";
import { accountIdForWebRequest } from "../../../../../../server/auth-context.js";
export const runtime = "nodejs";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  const { id, file } = await params;
  if (file !== "index.m3u8" && !/^\d{1,9}\.ts$/.test(file)) return new Response(null, { status: 404 });
  const accountId = await accountIdForWebRequest();
  const config = loadConfig();
  const blobs = configuredBlobStore(config);
  try {
    const media = await readBrowserMedia(db(), blobs, configuredKeyWrapper(config), { accountId, sessionId: id, ...(file === "index.m3u8" ? {} : { sequence: Number(file.slice(0, -3)) }) });
    return new Response(new Uint8Array(media.bytes), { headers: { "Content-Type": media.mime, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch { return new Response(null, { status: 404 }); }
}

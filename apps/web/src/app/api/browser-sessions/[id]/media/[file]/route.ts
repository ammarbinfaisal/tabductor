import { loadConfig } from "@tabductor/core";
import { createMinioBlobStore } from "@tabductor/browser/blob-store";
import { fileKeyWrapper } from "@tabductor/secrets";
import { readBrowserMedia } from "@tabductor/engine";
import { db } from "../../../../../../server/db.js";
import { accountIdForWebRequest } from "../../../../../../server/auth-context.js";
export const runtime = "nodejs";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  const { id, file } = await params;
  if (file !== "index.m3u8" && !/^\d{1,9}\.ts$/.test(file)) return new Response(null, { status: 404 });
  const accountId = await accountIdForWebRequest();
  const config = loadConfig();
  const blobs = createMinioBlobStore({ endpoint: config.BLOB_ENDPOINT, accessKey: config.BLOB_ACCESS_KEY, secretKey: config.BLOB_SECRET_KEY, bucket: config.BLOB_BUCKET });
  try {
    const media = await readBrowserMedia(db(), blobs, fileKeyWrapper(config.SECRETS_KEK_FILE_PATH), { accountId, sessionId: id, ...(file === "index.m3u8" ? {} : { sequence: Number(file.slice(0, -3)) }) });
    return new Response(new Uint8Array(media.bytes), { headers: { "Content-Type": media.mime, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch { return new Response(null, { status: 404 }); }
}

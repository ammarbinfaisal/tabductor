import { getEncoding } from "js-tiktoken";
import { AppError } from "./errors.js";

const tokenChunks = new Map<string, number>();
let encoding: ReturnType<typeof getEncoding> | undefined;

/** An admission estimate, not provider usage. Billing always uses reported usage.
 * Count text tokens rather than treating each UTF-8 byte as a token. The margin covers
 * message/tool framing and tokenizer differences; the provider remains authoritative.
 */
export function estimateModelInput(value: unknown): { inputTokenBound: number; requestBytes: number } {
  const text = JSON.stringify(value);
  const requestBytes = Buffer.byteLength(text, "utf8");
  if (requestBytes > 4_000_000) throw new AppError("model_request_size_limit", "model request exceeds 4 MB; reduce tool data or compact history");
  encoding ??= getEncoding("o200k_base");
  let imageAllowance = 0;
  const tokenText = JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && (
      typeof item.data === "string" && ["image/png", "image/jpeg"].includes(item.mime) ||
      item.type === "file" && ["image/png", "image/jpeg"].includes(item.mediaType) && item.data?.type === "data")) {
      imageAllowance += 8192; // Conservative admission allowance; provider usage remains authoritative.
      return { mime: item.mime ?? item.mediaType, imageBytes: Math.ceil((typeof item.data === "string" ? item.data.length : item.data.data.length) * 3 / 4) };
    }
    return item;
  });
  let tokens = 0;
  // Reused conversation prefixes and schemas should not be retokenized on every turn.
  // Chunk boundaries may overcount slightly; admission already includes a safety margin.
  for (let offset = 0; offset < tokenText.length; offset += 512) {
    const chunk = tokenText.slice(offset, offset + 512);
    let count = tokenChunks.get(chunk);
    if (count === undefined) {
      count = encoding.encode(chunk, [], []).length;
      if (tokenChunks.size >= 1024) tokenChunks.delete(tokenChunks.keys().next().value!);
      tokenChunks.set(chunk, count);
    }
    tokens += count;
  }
  return { inputTokenBound: Math.ceil(tokens * 1.25) + 1024 + imageAllowance, requestBytes };
}

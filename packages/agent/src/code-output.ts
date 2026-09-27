/** Preserve both orientation and the final outcome, with an explicit retrievable gap. */
export function pythonOutputPreview(output: string) {
  if (output.length <= 8000) return { output, outputChars: output.length, outputTruncated: false };
  const headEnd = 3000, tailStart = output.length - 4500;
  return { output: output.slice(0, headEnd) + `\n[Output characters ${headEnd}..${tailStart} omitted; use browser.output.read with this invocationId and offset=${headEnd}.]\n` + output.slice(tailStart),
    outputChars: output.length, outputTruncated: true, omittedRange: { start: headEnd, end: tailStart } };
}

export const CODE_OUTPUT_GUIDANCE = `browser.code return values must fit within 8000 characters after JSON.stringify, including keys, escaping, URLs and element metadata. page.perceive maxChars limits only page text, not the whole return. Prefer focused page.find/page.inspect calls; return only needed fields, clipped text and a few {anchor,role,name} elements. Do not return whole SDK results or full element objects. Check JSON.stringify(summary).length and reduce the summary if necessary. For example:
const p = await api.page.perceive({maxChars:1500,elementLimit:10});
if (!p.ok) return {ok:false,code:p.code,error:p.error};
return {url:p.value.url.slice(0,500),text:p.value.text.slice(0,1200),elements:p.value.elements.slice(0,10).map(e=>({anchor:e.anchor,role:e.role,name:(e.name||'').slice(0,100)}))};
An output_too_large result means only the returned summary exceeded the limit; preceding operations were not rolled back. Use the attached partial observation and operation receipt, then inspect with a smaller read-only program. Never repeat writes just to obtain a shorter return. Timers such as setTimeout are unavailable; use SDK readiness waits.
An authentication popup may close normally after sign-in. On browser_page_closed or page_closed recovery, use api.tabs.list({}) and api.tabs.switch({id}) to return to the surviving destination and obtain fresh anchors. Do not repeat login or a prior write before inspecting the destination.`;

/** A deliberately partial observation for recovering an oversized browser.code return.
 * Only model-visible fields enter this fallback; never raw locators or image bytes.
 */
export function compactCodeObservation(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Record<string, unknown>;
  if (typeof p.text !== "string" || !Array.isArray(p.elements)) return undefined;
  const clip = (v: unknown, length: number) => typeof v === "string" ? v.slice(0, length) : undefined;
  const elements = p.elements.slice(0, 15).map((item: Record<string, unknown>) => ({
    anchor: clip(item.anchor, 120), role: clip(item.role, 60), name: clip(item.name, 160),
  }));
  const result = { partial: true, next: "Use page.find or a smaller page.perceive call for omitted details; use fresh anchors.",
    pageId: clip(p.pageId, 80), snapshotId: clip(p.snapshotId, 100),
    url: clip(p.url, 512), title: clip(p.title, 160), text: p.text.slice(0, 1200), elements };
  // Escaped strings count too. Do not silently return an invalid JSON prefix.
  while (JSON.stringify(result).length > 5000 && elements.length) elements.pop();
  while (JSON.stringify(result).length > 5000 && result.text.length) result.text = result.text.slice(0, Math.floor(result.text.length / 2));
  while (JSON.stringify(result).length > 5000 && result.url?.length) result.url = result.url.slice(0, Math.floor(result.url.length / 2));
  return result;
}

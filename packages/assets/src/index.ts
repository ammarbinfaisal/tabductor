export { ASSET_PATH_INVALID, normalizeAssetPath } from "./paths.js";
export { checkWriteGrant } from "./grants.js";
// S5f: the non-tool-shaped read path `page.upload` needs — an asset ref (`{asset_id, path,
// mime, sha256}`) in, raw bytes out, no LLM-facing truncation or wrapping.
export { readAssetById, type ReadAssetDeps, type ResolvedAsset } from "./read.js";
export {
  buildAssetToolRegistry,
  type AssetTool,
  type AssetToolDeps,
  type AssetToolResult,
} from "./tools.js";
// S5e: document generation (`assets.render`, techical_plan §13.5) — a standalone tool + HTTP
// client to `apps/renderer`, not wired into any registry here (S5c/S5f's job).
export { buildRenderTool, type RenderToolDeps } from "./render.js";
export {
  createRenderClient,
  type RenderClient,
  type RenderClientOptions,
  type RenderJob,
  type RenderOutcome,
} from "./render-client.js";

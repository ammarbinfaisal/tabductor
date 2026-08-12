import { AppError } from "@tabductor/core";
import { assets } from "@tabductor/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { checkWriteGrant } from "./grants.js";
import { ASSET_PATH_INVALID, normalizeAssetPath } from "./paths.js";
import type { RenderClient } from "./render-client.js";
import { putVersion, type AssetTool, type AssetToolDeps, type AssetToolResult } from "./tools.js";

/**
 * `assets.render` (S5e, techical_plan §13.5, §16 Threat 7) — document generation, the
 * counterpart to `tools.ts`'s data-saving `assets.write`. This file is deliberately separate
 * from `tools.ts` (house rule: do not restructure that file) and is not itself wired into any
 * `(kind, mode)` tool registry — S5c/S5f own the loop that calls `buildRenderTool` and merges
 * its output alongside `buildAssetToolRegistry`'s. What this file provides is one more
 * `AssetTool`, shaped exactly like the others.
 *
 * The renderer worker (`apps/renderer`) is out-of-process and network-less by design (§16
 * Threat 7) — it cannot reach the asset store's blob backend, so **this file is "the host"**
 * the S5e spec keeps referring to: it resolves `srcPath` and every declared image out of the
 * asset store *before* calling the renderer client, and the `.tex` source it sends never
 * contains anything but a bare filename for an `\includegraphics` target. There is no
 * mechanism by which a host path could reach the sandbox — proven by the hostile-corpus test
 * that points `\includegraphics` at a literal absolute path and gets the same failure
 * `\input{/etc/passwd}` gets, because the sandbox's filesystem simply has nothing at that path
 * (`apps/renderer/sandbox/Dockerfile` is built `FROM scratch`).
 */

const DOCX_REJECTION_MESSAGE = "docx output is deferred, see §13.5";

const RENDER_PARAMS = z.object({
  srcPath: z.string().min(1),
  format: z.enum(["pdf", "deck", "docx"]),
  outputPath: z.string().min(1),
  /** Every `\includegraphics{name}` the `.tex` will reference, resolved from a prior asset.
   * `filename` is the bare name the tool's own contract told the LLM to use — never
   * discovered, never a path (S5e deliverable 2). */
  images: z
    .array(
      z.object({
        assetPath: z.string().min(1),
        filename: z
          .string()
          .min(1)
          .regex(/^[\w.-]+$/, "filename must be a bare name — no path separators"),
      }),
    )
    .max(20)
    .default([]),
});

export type RenderToolDeps = AssetToolDeps & { render: RenderClient };

async function readCurrentAssetBytes(
  deps: RenderToolDeps,
  path: string,
): Promise<{ bytes: Buffer; mime: string } | undefined> {
  const [row] = await deps.db
    .select({ blobRef: assets.blobRef, mime: assets.mime })
    .from(assets)
    .where(and(eq(assets.userId, deps.userId), eq(assets.path, path)));
  if (!row) return undefined;
  return { bytes: await deps.blobs.get(row.blobRef), mime: row.mime };
}

async function lookupAssetId(deps: RenderToolDeps, path: string): Promise<string> {
  const [row] = await deps.db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.userId, deps.userId), eq(assets.path, path)));
  // `putVersion` just wrote this row; it cannot be missing.
  return row!.id;
}

export function buildRenderTool(deps: RenderToolDeps): AssetTool {
  return {
    name: "assets.render",
    description:
      "Compile a `.tex` asset (previously written via assets.write) into a PDF deliverable and " +
      "store it as a new asset version at `outputPath`. `format` is `pdf` (a document) or `deck` " +
      "(a beamer presentation, delivered as a **PDF deck** — never an editable .pptx). `docx` is " +
      "not implemented and is rejected outright. Images the `.tex` references via " +
      "`\\includegraphics{name}` must be listed in `opts.images` as `{assetPath, filename}` — " +
      "`filename` is exactly the bare name to use inside the `.tex`; there is no way for the " +
      "document to name a host path. On a compile failure the full TeX log comes back as a tool " +
      "error so you can fix the source (another assets.write) and call assets.render again.",
    parameters: RENDER_PARAMS,
    async execute(rawArgs): Promise<AssetToolResult> {
      const parsed = RENDER_PARAMS.safeParse(rawArgs);
      if (!parsed.success) {
        return { ok: false, error: `invalid arguments for "assets.render": ${parsed.error.message}` };
      }
      const { srcPath, format, outputPath, images } = parsed.data;

      // §18.12: docx gets no partial implementation, not even a stub that degrades to PDF.
      // Rejected before any path is normalized, any blob is read, or the renderer client is
      // ever called — the hostile/contract test asserts a zero call count on the client for
      // exactly this reason: a silent downgrade to PDF would hide that the requested format
      // was never produced, which is worse than a clear, typed refusal (§13.5, §18.12).
      if (format === "docx") {
        return { ok: false, error: DOCX_REJECTION_MESSAGE };
      }

      let normalizedSrc: string;
      let normalizedOut: string;
      try {
        normalizedSrc = normalizeAssetPath(deps.userId, srcPath);
        normalizedOut = normalizeAssetPath(deps.userId, outputPath);
      } catch (err) {
        if (err instanceof AppError && err.code === ASSET_PATH_INVALID) return { ok: false, error: err.message };
        throw err;
      }

      // Fail before spending a sandboxed compile on a write that could never land — the same
      // grant `assets.write` enforces, checked up front rather than after the render.
      const allowed = await checkWriteGrant(deps.db, deps.taskId, normalizedOut);
      if (!allowed) {
        return { ok: false, error: `write outside this task's granted paths: "${normalizedOut}"` };
      }

      const src = await readCurrentAssetBytes(deps, normalizedSrc);
      if (!src) return { ok: false, error: `no asset at "${normalizedSrc}"` };

      const files: { filename: string; bytes: Buffer }[] = [];
      for (const image of images) {
        let normalizedImage: string;
        try {
          normalizedImage = normalizeAssetPath(deps.userId, image.assetPath);
        } catch (err) {
          if (err instanceof AppError && err.code === ASSET_PATH_INVALID) return { ok: false, error: err.message };
          throw err;
        }
        const resolved = await readCurrentAssetBytes(deps, normalizedImage);
        if (!resolved) return { ok: false, error: `no asset at "${normalizedImage}" (image "${image.filename}")` };
        files.push({ filename: image.filename, bytes: resolved.bytes });
      }

      const startedAt = Date.now();
      const outcome = await deps.render.render({
        texSource: src.bytes.toString("utf8"),
        files,
        format,
      });
      const elapsedSeconds = (Date.now() - startedAt) / 1000;

      if (!outcome.ok) {
        if (outcome.kind === "killed") {
          deps.metrics?.renderDuration.record(elapsedSeconds, { outcome: "killed" });
          deps.metrics?.renderSandboxKills.add({ reason: outcome.reason });
        } else {
          deps.metrics?.renderDuration.record(elapsedSeconds, { outcome: "compile_error" });
        }
        // The whole reason this subphase exists in this shape: LaTeX from an LLM fails
        // routinely on missing packages and stray characters, and a one-shot failure would
        // make the feature unusable in practice — the odds of a first draft compiling clean
        // are low enough that "no retry" is equivalent to "doesn't work." Returning the TeX
        // log as a *tool error* (not throwing, not failing the run) is what lets the agent
        // read the diagnostic, correct the source via another assets.write, and retry
        // assets.render within its step budget — the correct-and-retry shape S4b's
        // emit-validation-retry already established for packet schemas, applied here to a
        // different failure surface.
        const reason = outcome.kind === "killed" ? ` (sandbox killed: ${outcome.reason})` : "";
        return { ok: false, error: `LaTeX render failed${reason}:\n${outcome.log}` };
      }

      const written = await putVersion(deps, { path: normalizedOut, bytes: outcome.pdf, mime: "application/pdf" });
      if (!written.ok) {
        deps.metrics?.renderDuration.record(elapsedSeconds, { outcome: "write_error" });
        return written;
      }
      deps.metrics?.renderDuration.record(elapsedSeconds, { outcome: "ok" });

      const assetId = await lookupAssetId(deps, normalizedOut);
      const value = written.value as { path: string; version: number; mime: string; sha256: string; size: number };
      return {
        ok: true,
        value: {
          asset_id: assetId,
          path: value.path,
          mime: value.mime,
          sha256: value.sha256,
          size: value.size,
          version: value.version,
          // §18.11: beamer output is a PDF deck, never a `.pptx` claim — this label is the
          // whole discipline the deliverable asks for, since the bytes are identical PDF
          // either way.
          kind: format === "deck" ? "pdf_deck" : "pdf",
          label: format === "deck" ? "PDF deck" : "PDF",
        },
      };
    },
  };
}

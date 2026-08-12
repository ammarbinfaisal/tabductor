import { afterAll, beforeAll, expect, it } from "vitest";
import { newId } from "@tabductor/core";
import {
  buildAssetToolRegistry,
  buildRenderTool,
  createRenderClient,
  type AssetTool,
  type AssetToolDeps,
  type AssetToolResult,
  type RenderToolDeps,
} from "@tabductor/assets";
import { assetWriteGrants, assets } from "@tabductor/db";
import { createMigratedTestDb, type MigratedTestDb } from "@tabductor/db/test-db";
import { seedWorkflow } from "@tabductor/engine";
import { createTestBlobStore, type TestBlobStore } from "@tabductor/testkit";
import { eq } from "drizzle-orm";
import {
  countingRenderClient,
  normalizePdfBytes,
  readFixture,
  readFixtureText,
  startLatexRig,
  type LatexRig,
} from "./latex-support.js";

/**
 * S5e: `assets.render` against the *real* containerised `apps/renderer` (`latex-support.ts`
 * builds and runs the actual `apps/renderer/sandbox` image via Docker — this is not a bare
 * local `tectonic` invocation). The hostile corpus lives in its own file
 * (`latex-hostile-corpus.test.ts`); this one is the tool contract: happy path, correct-and-
 * retry, deck labelling, docx rejection, image resolution, write grants.
 */

const USER = "user_test";

let handle: MigratedTestDb | undefined;
let tb: TestBlobStore | undefined;
let rig: LatexRig | undefined;

beforeAll(async () => {
  rig = await startLatexRig();
}, 300_000); // cold sandbox-image build can take several minutes; cached, later runs are instant.

afterAll(async () => {
  await rig?.stop();
});

async function setup(): Promise<{
  deps: AssetToolDeps;
  writeTools: AssetTool[];
  renderTool: AssetTool;
  callCount: () => number;
  taskId: string;
}> {
  handle = await createMigratedTestDb();
  tb = await createTestBlobStore();
  const wf = await seedWorkflow(handle.db, { userId: USER, tasks: { A: { kind: "asset", mode: "ai" } } });
  const taskId = wf.taskIds.A!;
  const deps: AssetToolDeps = { db: handle.db, blobs: tb.store, userId: USER, taskId, runId: newId("run") };
  const counting = countingRenderClient(createRenderClient({ url: rig!.server.url }));
  const renderDeps: RenderToolDeps = { ...deps, render: counting };
  return {
    deps,
    writeTools: buildAssetToolRegistry(deps),
    renderTool: buildRenderTool(renderDeps),
    callCount: counting.callCount,
    taskId,
  };
}

function tool(tools: AssetTool[], name: string): AssetTool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool "${name}"`);
  return t;
}

function okValue(result: AssetToolResult): unknown {
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
  return result.value;
}

async function teardown(): Promise<void> {
  await tb?.drop();
  tb = undefined;
  await handle?.close();
  handle = undefined;
}

it("compiles a happy-path .tex into a byte-stable PDF asset", async () => {
  const { writeTools, renderTool } = await setup();
  try {
    await tool(writeTools, "assets.write").execute({
      path: "src/happy.tex",
      content: readFixtureText("happy.tex"),
      mime: "text/x-tex",
    });

    const result = await renderTool.execute({
      srcPath: "src/happy.tex",
      format: "pdf",
      outputPath: "reports/happy.pdf",
    });
    expect(result.ok).toBe(true);
    const value = okValue(result) as { path: string; mime: string; kind: string; sha256: string; asset_id: string };
    expect(value).toMatchObject({ path: "/reports/happy.pdf", mime: "application/pdf", kind: "pdf" });
    expect(value.asset_id).toBeTruthy();

    const pdf = await tb!.store.get(
      (
        await handle!.db.select({ blobRef: assets.blobRef }).from(assets).where(eq(assets.path, "/reports/happy.pdf"))
      )[0]!.blobRef,
    );
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    // Byte-stable after normalizing the one thing that varies (the trailer's random /ID) —
    // rendering the identical source a second time must produce the identical normalized PDF.
    const second = await renderTool.execute({
      srcPath: "src/happy.tex",
      format: "pdf",
      outputPath: "reports/happy-again.pdf",
    });
    const secondBlobRef = (
      await handle!.db
        .select({ blobRef: assets.blobRef })
        .from(assets)
        .where(eq(assets.path, "/reports/happy-again.pdf"))
    )[0]!.blobRef;
    const secondPdf = await tb!.store.get(secondBlobRef);
    expect(second.ok).toBe(true);
    expect(normalizePdfBytes(pdf)).toEqual(normalizePdfBytes(secondPdf));
  } finally {
    await teardown();
  }
});

it("a malformed .tex surfaces the TeX log as a tool error; a corrected retry succeeds", async () => {
  const { writeTools, renderTool } = await setup();
  try {
    await tool(writeTools, "assets.write").execute({
      path: "src/doc.tex",
      content: readFixtureText("malformed.tex"),
      mime: "text/x-tex",
    });

    const failed = await renderTool.execute({ srcPath: "src/doc.tex", format: "pdf", outputPath: "out/doc.pdf" });
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error("expected failure");
    // The actual compiler diagnostic, not a generic message — the whole point of the
    // correct-and-retry contract is that the agent can read *why* it failed.
    expect(failed.error).toMatch(/this-package-does-not-exist/);
    expect(failed.error).toMatch(/not found/i);

    // No asset was written on failure.
    const rows = await handle!.db.select().from(assets).where(eq(assets.path, "/out/doc.pdf"));
    expect(rows).toHaveLength(0);

    // Corrected retry: another assets.write to the same srcPath, then assets.render again.
    await tool(writeTools, "assets.write").execute({
      path: "src/doc.tex",
      content: readFixtureText("malformed-fixed.tex"),
      mime: "text/x-tex",
    });
    const retried = await renderTool.execute({ srcPath: "src/doc.tex", format: "pdf", outputPath: "out/doc.pdf" });
    expect(retried.ok).toBe(true);
  } finally {
    await teardown();
  }
});

it("resolves a host-written image into scratch before compilation", async () => {
  const { deps, writeTools, renderTool } = await setup();
  try {
    await tool(writeTools, "assets.write").execute({
      path: "src/withimg.tex",
      content: readFixtureText("with-image.tex"),
      mime: "text/x-tex",
    });

    // The image asset did not come through `assets.write` (its mime is outside that tool's
    // text-only allowlist by design — §13.5 splits "data saving" from binary deliverables) —
    // it is seeded directly, standing in for how a real one would arrive: a browser
    // download landing in the store under the `download` grant (§13.5's "Assets and the
    // browser node").
    const pngBytes = readFixture("figure.png");
    const blobRef = await deps.blobs.put(pngBytes, { mime: "image/png" });
    const sha256 = blobRef.slice("sha256:".length);
    await handle!.db.insert(assets).values({
      id: newId("asset"),
      userId: USER,
      path: "/figures/figure.png",
      mime: "image/png",
      size: pngBytes.byteLength,
      sha256,
      blobRef,
      currentVersion: 1,
    });

    const result = await renderTool.execute({
      srcPath: "src/withimg.tex",
      format: "pdf",
      outputPath: "out/withimg.pdf",
      images: [{ assetPath: "figures/figure.png", filename: "figure.png" }],
    });
    expect(result.ok).toBe(true);
  } finally {
    await teardown();
  }
});

it("an .tex referencing a host path directly fails the same way \\input{/etc/passwd} does", async () => {
  const { writeTools, renderTool } = await setup();
  try {
    await tool(writeTools, "assets.write").execute({
      path: "src/hostpath.tex",
      content: readFixtureText("with-image-host-path.tex"),
      mime: "text/x-tex",
    });
    const result = await renderTool.execute({
      srcPath: "src/hostpath.tex",
      format: "pdf",
      outputPath: "out/hostpath.pdf",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toMatch(/not found/i);
  } finally {
    await teardown();
  }
});

it("a beamer render comes back a PDF, labelled a PDF deck — never a .pptx claim", async () => {
  const { writeTools, renderTool } = await setup();
  try {
    await tool(writeTools, "assets.write").execute({
      path: "src/deck.tex",
      content: readFixtureText("deck.tex"),
      mime: "text/x-tex",
    });
    const result = await renderTool.execute({ srcPath: "src/deck.tex", format: "deck", outputPath: "out/deck.pdf" });
    expect(result.ok).toBe(true);
    const value = okValue(result) as { mime: string; kind: string; label: string };
    expect(value.mime).toBe("application/pdf");
    expect(value.kind).toBe("pdf_deck");
    expect(value.label).toBe("PDF deck");
    expect(JSON.stringify(value)).not.toMatch(/\.pptx/);
  } finally {
    await teardown();
  }
});

it('docx is rejected with a "deferred, see §13.5" error and never reaches the sandbox', async () => {
  const { writeTools, renderTool, callCount } = await setup();
  try {
    await tool(writeTools, "assets.write").execute({
      path: "src/doc.tex",
      content: readFixtureText("happy.tex"),
      mime: "text/x-tex",
    });
    const result = await renderTool.execute({ srcPath: "src/doc.tex", format: "docx", outputPath: "out/doc.docx" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toMatch(/deferred/i);
    expect(result.error).toMatch(/§13\.5/);
    // The point of this assertion, per the spec: prove the renderer client was never called,
    // not just that the tool returned an error shape.
    expect(callCount()).toBe(0);
  } finally {
    await teardown();
  }
});

it("a write outside the task's granted paths is denied before the sandbox ever runs", async () => {
  const { writeTools, renderTool, callCount, taskId } = await setup();
  try {
    await handle!.db.insert(assetWriteGrants).values({ taskId, pathGlob: "/reports/**" });

    await tool(writeTools, "assets.write").execute({
      path: "src/doc.tex",
      content: readFixtureText("happy.tex"),
      mime: "text/x-tex",
    });
    const result = await renderTool.execute({
      srcPath: "src/doc.tex",
      format: "pdf",
      outputPath: "elsewhere/doc.pdf",
    });
    expect(result.ok).toBe(false);
    expect(callCount()).toBe(0);
  } finally {
    await teardown();
  }
});

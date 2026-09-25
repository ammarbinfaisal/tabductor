import type { BlobStore, TraceRecorder } from "@tabductor/browser";
import type { CheckpointStore } from "./batch-tools.js";
import { defineTool } from "./tools.js";
import { z } from "zod";

export type WorkspaceFile = { content: string; encoding: "utf8" | "base64" };
export type WorkspaceFiles = Record<string, WorkspaceFile>;
type Manifest = Record<string, { ref: string; encoding: WorkspaceFile["encoding"]; bytes: number }>;
export type RunWorkspace = ReturnType<typeof createRunWorkspace>;
const fileSchema = z.object({ content: z.string(), encoding: z.enum(["utf8", "base64"]).default("utf8") });
function path(name: string) {
  if (!name || name.length > 512 || name.startsWith("/") || name.includes("\\") || name.includes("\0") || name.split("/").some(p => !p || p === "." || p === "..")) throw new Error("Expected a relative workspace file path");
  return name;
}

/** The manifest is committed atomically under the run lease; blobs are immutable. */
export function createRunWorkspace(blobs: BlobStore, state: CheckpointStore, trace?: TraceRecorder) {
  async function manifest(): Promise<Manifest> {
    const saved = await state.get() as { ref?: string } | null;
    return saved?.ref ? JSON.parse((await blobs.get(saved.ref)).toString()) as Manifest : {};
  }
  async function read(name: string): Promise<WorkspaceFile> {
    const item = (await manifest())[path(name)];
    if (!item) throw new Error(`Workspace file missing: ${name}`);
    return { content: (await blobs.get(item.ref)).toString(item.encoding === "utf8" ? "utf8" : "base64"), encoding: item.encoding };
  }
  async function commit(files: WorkspaceFiles) {
    if (Object.keys(files).length > 256) throw new Error("Workspace exceeds 256 files");
    const next: Manifest = Object.create(null);
    let total = 0;
    for (const [name, file] of Object.entries(files)) {
      path(name);
      const bytes = Buffer.from(file.content, file.encoding);
      total += bytes.length;
      if (bytes.length > 8_000_000 || total > 32_000_000) throw new Error("Workspace exceeds file (8 MB) or total (32 MB) budget");
      next[name] = { ref: await blobs.put(bytes, { mime: "application/octet-stream" }), encoding: file.encoding, bytes: bytes.length };
    }
    const ref = await blobs.put(Buffer.from(JSON.stringify(next)), { mime: "application/json" });
    await state.set({ ...await state.get() as object, ref });
    await trace?.record("action", { action: "workspace.checkpoint", ref, files: next });
    return { ref, files: Object.keys(next), bytes: total };
  }
  async function snapshot() {
    const files: WorkspaceFiles = Object.create(null);
    for (const name of Object.keys(await manifest())) files[name] = await read(name);
    return files;
  }
  return {
    snapshot, commit, read,
    async saveOutput(invocationId: string, output: string) {
      const current = await state.get() as {ref?:string;outputs?:Record<string,string>} | null;
      const outputs = {...current?.outputs,[invocationId]:await blobs.put(Buffer.from(output),{mime:"text/plain"})};
      await state.set({...current,outputs:Object.fromEntries(Object.entries(outputs).slice(-64))});
    },
    tools: () => [
      defineTool({name:"output.read",description:"Read a bounded slice of a Python output artifact from this run, including output before exceptions.",parameters:z.object({invocationId:z.string(),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(8000).default(4000)}),execute:async a=>{
        const saved=await state.get() as {outputs?:Record<string,string>} | null;
        const ref=saved?.outputs?.[a.invocationId];
        if(!ref)return {ok:false,error:"Output artifact unavailable in this run"};
        const text=(await blobs.get(ref)).toString("utf8");
        return {ok:true,value:{text:text.slice(a.offset,a.offset+a.limit),characters:text.length,nextOffset:a.offset+a.limit<text.length?a.offset+a.limit:null}};
      }}),
      defineTool({ name: "workspace.list", description: "List committed run files and versions.", parameters: z.object({}), execute: async () => ({ ok: true, value: await manifest() }) }),
      defineTool({ name: "workspace.read", description: "Read a committed run file. JSON files use UTF-8 content.", parameters: z.object({ path: z.string() }), execute: async a => ({ ok: true, value: await read(a.path) }) }),
      defineTool({ name: "workspace.commit", description: "Atomically replace the run workspace with files. Python checkpoints ordinary files automatically.", parameters: z.object({ files: z.record(fileSchema) }), execute: async a => ({ ok: true, value: await commit(a.files) }) }),
      defineTool({ name: "workspace.write", description: "Write one run file while preserving other committed files.", parameters: z.object({ path: z.string(), ...fileSchema.shape }), execute: async a => ({ ok: true, value: await commit({ ...await snapshot(), [path(a.path)]: { content: a.content, encoding: a.encoding } }) }) }),
    ],
  };
}

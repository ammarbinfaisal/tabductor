import { graphStoreArtifactSchema, runWorkflowChat, workflowChatInputSchema } from "@tabductor/engine";
import { storeSchemas } from "@tabductor/db";
import { desc, eq } from "drizzle-orm";
import { createContext } from "../../../server/trpc.js";
import { accountIdForWebRequest } from "../../../server/auth-context.js";
import { createCaller } from "../../../server/router.js";
import { loadGateContext } from "../../../server/routers/workflow.js";
import { workflowChatModel } from "../../../server/schema-generator.js";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  let input;
  try {
    const raw = await request.text();
    if (raw.length > 2_000_000) return Response.json({ error: "This conversation is too large. Start a new message with a shorter request." }, { status: 413 });
    input = workflowChatInputSchema.parse(JSON.parse(raw));
    if (input.messages.at(-1)?.role !== "user") throw new Error("Missing user message");
  } catch {
    return Response.json({ error: "The message could not be read. Please try again." }, { status: 400 });
  }
  const ctx = { ...createContext(), accountId: await accountIdForWebRequest() };
  const model = workflowChatModel();
  if (!model || !ctx.graphCompiler) return Response.json({ error: "The workflow assistant is not configured on this server." }, { status: 503 });
  const caller = createCaller(ctx);
  const current = await caller.workflow.get({ id: input.workflowId });
  if (current.versionId !== input.versionId) return Response.json({ error: "This workflow has a newer published version. Reload it before continuing." }, { status: 409 });
  if (!input.current.store) {
    const [persisted] = await ctx.db.select().from(storeSchemas).where(eq(storeSchemas.workflowId, input.workflowId)).orderBy(desc(storeSchemas.version)).limit(1);
    if (persisted) input.current.store = graphStoreArtifactSchema.parse({ description: persisted.descriptionText, ddl: persisted.ddl, tablesSpec: persisted.tablesSpecJson });
  }
  const gateContext = await loadGateContext(ctx, input.workflowId);
  const encoder = new TextEncoder();
  const compiler = ctx.graphCompiler;
  const workflowId = input.workflowId;
  const abort = new AbortController();
  const signal = AbortSignal.any([request.signal, abort.signal]);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      await runWorkflowChat(input, {
        model, compiler, gateContext, signal,
        publish: (artifact, expectedVersionId) => caller.workflow.publishVersion({
          workflowId, expectedVersionId, graph: artifact.graph,
          authoring: { report: { checks: [], attempts: 1 }, proposedGrants: artifact.proposedGrants, ...(artifact.store ? { store: artifact.store } : {}) },
        }),
        onEvent: (event) => {
          if (!open) return;
          try { controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); } catch { open = false; }
        },
      });
      if (open) { try { controller.close(); } catch { /* Client disconnected. */ } }
    },
    cancel() { abort.abort(); },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}

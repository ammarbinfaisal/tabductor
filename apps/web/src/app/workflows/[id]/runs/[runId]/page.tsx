import { notFound } from "next/navigation";
import { TRPCError } from "@trpc/server";
import { RunInspector } from "../../../../../components/run-inspector.js";
import { createCaller } from "../../../../../server/router.js";

export const dynamic = "force-dynamic";

/**
 * The run inspector (U1.5). Server component just proves the run exists (the same 404
 * pattern `workflows/[id]/page.tsx` uses); `RunInspector` re-fetches client-side because it
 * polls — this initial call exists for the 404, not to hand down initial state.
 */
export default async function RunPage({ params }: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await params;
  await createCaller()
    .run.get({ runId })
    .catch((err: unknown) => {
      if (err instanceof TRPCError && err.code === "NOT_FOUND") notFound();
      throw err;
    });

  return <RunInspector workflowId={id} runId={runId} />;
}

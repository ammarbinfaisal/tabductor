import { notFound } from "next/navigation";
import { TRPCError } from "@trpc/server";
import { GraphEditor } from "../../../components/graph-editor.js";
import { createCaller } from "../../../server/router.js";

export const dynamic = "force-dynamic";

/** Server component: fetch the graph once, hand it to the client editor as its initial state. */
export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const got = await createCaller()
    .workflow.get({ id })
    .catch((err: unknown) => {
      if (err instanceof TRPCError && err.code === "NOT_FOUND") notFound();
      throw err;
    });

  return (
    <GraphEditor
      workflowId={got.workflow.id}
      workflowName={got.workflow.name}
      versionId={got.versionId}
      graph={got.graph}
      tasks={got.tasks}
    />
  );
}

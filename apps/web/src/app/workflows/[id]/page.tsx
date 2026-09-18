import { notFound } from "next/navigation";
import { loadConfig } from "@tabductor/core";
import { TRPCError } from "@trpc/server";
import { GraphEditor } from "../../../components/graph-editor.js";
import { createServerCaller } from "../../../server/router.js";

export const dynamic = "force-dynamic";

/** Server component: fetch the graph once, hand it to the client editor as its initial state. */
export default async function WorkflowPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ event?: string }> }) {
  const [{ id }, { event }] = await Promise.all([params, searchParams]);
  const got = await (await createServerCaller())
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
      eventSchemas={got.eventSchemas}
      authoring={got.authoring}
      maxHops={got.workflow.maxHops}
      showGraph={loadConfig().TABDUCTOR_DEPLOYMENT_MODE === "local"}
      {...(event ? { initialEventId: event } : {})}
    />
  );
}

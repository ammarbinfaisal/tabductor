import { notFound } from "next/navigation";
import { TRPCError } from "@trpc/server";
import { PromptEditor } from "../../../components/prompt-editor.js";
import { createServerCaller } from "../../../server/router.js";
export const dynamic = "force-dynamic";
export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workflow = await (await createServerCaller()).workflow.get({ id }).catch((error: unknown) => {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") notFound();
    throw error;
  });
  return <PromptEditor {...workflow} />;
}

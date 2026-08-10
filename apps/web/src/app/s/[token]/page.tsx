import { notFound } from "next/navigation";
import { TRPCError } from "@trpc/server";
import { SharedGraph } from "../../../components/shared-graph.js";
import { shareCaller } from "../../../server/share-caller.js";

export const dynamic = "force-dynamic";

export default async function SharedGraphPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const api = await shareCaller();
  const shared = await api.public.graph({ token }).catch((err: unknown) => {
    if (err instanceof TRPCError) notFound();
    throw err;
  });
  return <SharedGraph name={shared.name} graph={shared.graph} />;
}

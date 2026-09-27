import { notFound } from "next/navigation";
import { TRPCError } from "@trpc/server";
import { SharedOverview } from "../../../components/shared-overview.js";
import { shareCaller } from "../../../server/share-caller.js";

export const dynamic = "force-dynamic";

export default async function SharedOverviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const api = await shareCaller();
  const shared = await api.public.overview({ token }).catch((err: unknown) => {
    if (err instanceof TRPCError) notFound();
    throw err;
  });
  return <SharedOverview name={shared.name} overview={shared.overview} />;
}

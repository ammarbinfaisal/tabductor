import { BrowserProfiles } from "../../components/browser-profiles.js";
import { createServerCaller } from "../../server/router.js";
import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";
export default async function ProfilesPage({ searchParams }: { searchParams: Promise<{ workflow?: string }> }) {
  const { workflow } = await searchParams;
  if (workflow) redirect(`/workflows/${encodeURIComponent(workflow)}/settings#browser-profiles`);
  const caller = await createServerCaller();
  const profiles = await caller.browserSession.profiles();
  return <><h1>Browser profiles</h1><BrowserProfiles profiles={profiles} /></>;
}

import { BrowserProfiles } from "../../components/browser-profiles.js";
import { createServerCaller } from "../../server/router.js";
export const dynamic = "force-dynamic";
export default async function ProfilesPage({ searchParams }: { searchParams: Promise<{ workflow?: string }> }) {
  const { workflow } = await searchParams;
  const caller = await createServerCaller();
  const [profiles, binding] = await Promise.all([caller.browserSession.profiles(), workflow ? caller.browserSession.workflowProfile({ workflowId: workflow }) : null]);
  return <><h1>Browser profiles</h1><BrowserProfiles profiles={profiles} {...(workflow ? { workflowId: workflow } : {})} {...(binding ? { selectedProfileId: binding.profileId } : {})} /></>;
}

import { BrowserProfiles } from "../../../../components/browser-profiles.js";
import { ModelSettings } from "../../../../components/model-settings.js";
import { createServerCaller } from "../../../../server/router.js";
import { EndpointSettings } from "../../../../components/endpoint-settings.js";

export const dynamic = "force-dynamic";

/** Configure the workflow's browser profiles, model, and local endpoints. */
export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await createServerCaller();
  await caller.workflow.get({ id });
  const [models, profiles, binding] = await Promise.all([
    caller.account.modelSettings(),
    caller.browserSession.profiles(),
    caller.browserSession.workflowProfile({ workflowId: id }),
  ]);
  const managedBrowser = process.env.TABDUCTOR_DEPLOYMENT_MODE === "hosted" || process.env.BROWSER_MODE === "fleet";
  return (
    <>
      <h1>Settings</h1>
      <BrowserProfiles profiles={profiles} workflowId={id} allowSetup={managedBrowser}
        {...(binding ? { selectedProfileId: binding.profileId } : {})} />
      <ModelSettings settings={models} workflowId={id} />
      {!managedBrowser ? <EndpointSettings workflowId={id} /> : null}
    </>
  );
}

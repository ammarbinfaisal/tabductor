import { ModelSettings } from "../../../../components/model-settings.js";
import { createServerCaller } from "../../../../server/router.js";
import { EndpointSettings } from "../../../../components/endpoint-settings.js";

export const dynamic = "force-dynamic";

/** Workflow settings (U3a). One section today: the browser endpoints the runs rotate over. */
export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await createServerCaller();
  await caller.workflow.get({ id });
  const models = await caller.account.modelSettings();
  return (
    <>
      <h1>Settings</h1>
      <ModelSettings settings={models} workflowId={id} />
      <EndpointSettings workflowId={id} />
    </>
  );
}

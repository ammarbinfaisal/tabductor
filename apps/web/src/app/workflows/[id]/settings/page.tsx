import { EndpointSettings } from "../../../../components/endpoint-settings.js";

export const dynamic = "force-dynamic";

/** Workflow settings (U3a). One section today: the browser endpoints the runs rotate over. */
export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <h1>Settings</h1>
      <EndpointSettings workflowId={id} />
    </>
  );
}

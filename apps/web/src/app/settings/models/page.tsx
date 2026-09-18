import { createServerCaller } from "../../../server/router.js";
import { ModelSettings } from "../../../components/model-settings.js";
export const dynamic = "force-dynamic";
export default async function ModelsPage() {
  const caller = await createServerCaller();
  return <><h1>Models</h1><ModelSettings settings={await caller.account.modelSettings()} /></>;
}

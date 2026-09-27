// Run inside the existing engine container before deploying the prompt-runtime migrations.
// Uses the ordinary deletion queue: profiles, accounts, credentials and billing history remain.
import { createDb, workflows } from "@tabductor/db";
import { requestWorkflowDeletion } from "@tabductor/engine";
const handle = createDb(process.env.DATABASE_URL);
try {
  const items = await handle.db.select({ id: workflows.id, accountId: workflows.accountId }).from(workflows);
  for (const item of items) await requestWorkflowDeletion(handle.db, item.accountId, item.id);
  process.stdout.write(`Queued ${items.length} workflow deletions. Wait for the engine to finish settlement and cleanup before migration.\n`);
} finally { await handle.close(); }

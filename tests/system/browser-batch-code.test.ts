import { createServer } from "node:http";
import { expect, it } from "vitest";
import { seedWorkflow } from "@tabductor/engine";
import { taskState } from "@tabductor/db";
import { eq } from "drizzle-orm";
import { startAgentRig } from "./agent-support.js";
import { eventsOfType, runsForTask, trigger, waitFor } from "./engine-support.js";

it("browser code extracts 100 records, durably emits each once across batch retries, and checkpoints progress", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end("<main>" + Array.from({ length: 100 }, (_, i) => `<article data-testid="item" id="${i}"><b>author-${i}</b><span>record-${i}</span></article>`).join("") + "</main>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const rig = await startAgentRig({ llmFor: () => {
    let step = 0;
    return { complete: async () => ({ usage: { in: 1, out: 1 }, toolCalls: step++ === 0
      ? [{ id: "code", name: "browser.code", args: { source: `export default async function(tools) {
        const page = await tools.call('page.goto', {url: ${JSON.stringify(origin)}});
        if (!page.ok) throw new Error(page.error);
        let emitted = 0;
        for (let offset = 0; offset < 100; offset += 25) {
          const batch = await tools.call('page.extractBatch', {selector:'article', fields:{id:{attr:'id'},author:{selector:'b'},text:{selector:'span'}},offset,limit:25});
          if (!batch.ok) throw new Error(batch.error);
          const data = await tools.call('batch.read', {batchId:batch.value.batchId,limit:100});
          const input = {type:'item.found',items:data.value.records.map(packet=>({packet,dedupeKey:packet.id}))};
          for(let replay=0; replay<2; replay++) {
            const out = await tools.call('emit.batch',input);
            if (!out.ok) throw new Error(out.error);
          }
          emitted += data.value.records.length;
          await tools.call('checkpoint.set',{value:{emitted}});
          await tools.call('batch.release',{batchId:batch.value.batchId});
        }
        const verified = await tools.call('page.verify', {textIncludes:'record-99'});
        if (!verified.ok) throw new Error(verified.error);
        return {emitted};
      }` } }]
      : [{ id: "done", name: "browser.code", args: { source: "export default async api => api.run.done({})" } }] }) };
  } });
  try {
    const wf = await seedWorkflow(rig.handle.db, { tasks: { Start: {}, Collect: { mode: "ai", prompt: "Collect 100 items", consumes: ["work.requested"], emits: ["item.found"] } },
      events: { "item.found": { description: "An item", schema: { type: "object", properties: { id: { type: "string" }, author: { type: "string" }, text: { type: "string" } }, required: ["id", "author", "text"], additionalProperties: false } } } });
    await trigger(rig, wf.taskIds.Start!, "work.requested");
    await waitFor("collection to settle", async () => {
      const [run] = await runsForTask(rig, wf.taskIds.Collect!);
      return run && ["succeeded", "failed"].includes(run.status) ? run : false;
    });
    const events = await eventsOfType(rig, "item.found");
    expect(events).toHaveLength(100);
    for (const event of events) {
      const packet = event.packet as { id: string; author: string; text: string };
      expect(packet).toEqual({ id: packet.id, author: `author-${packet.id}`, text: `record-${packet.id}` });
    }
    expect(new Set(events.map((event) => (event.packet as { id: string }).id)).size).toBe(100);
    const checkpoint = await rig.handle.db.select().from(taskState).where(eq(taskState.taskId, wf.taskIds.Collect!));
    expect(checkpoint.some((row) => row.key.startsWith("agent-checkpoint:") && (row.value as { emitted: number }).emitted === 100)).toBe(true);
  } finally {
    await rig.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

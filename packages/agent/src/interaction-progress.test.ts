import { expect, it } from "vitest";
import { buildToolRegistry } from "./tools.js";
import type { RunSession } from "@tabductor/browser";

it.each([false, true])("AI may explore repeated editor states while static mode detects cycles (compiled: %s)", async (compiled) => {
  let open = false, mutations = 0;
  const perceive = async () => ({ url: "https://destination.test", title: "Records", text: open ? "editor" : "table", elements: [] });
  const session = { page: { perceive, click: async () => { open = true; mutations++; }, interact: async () => { open = false; mutations++; } }, resolveAnchor: () => "cell", snapshotId: () => "s1" } as unknown as RunSession;
  let value: unknown = null;
  const memory = { get: async () => value, set: async (v: unknown) => { value = v; } };
  const registry = () => new Map(buildToolRegistry({ session, compiled, memory, emit: async () => ({ outcome: "deduped" }) }).map(t => [t.name, t]));
  const tools = registry();
  for (let i = 0; i < 3; i++) {
    expect(await tools.get("page.click")!.execute({ anchor: "e1" })).toMatchObject({ ok: true });
    await tools.get("page.perceive")!.execute({});
    expect(await tools.get("page.press")!.execute({ key: "Escape" })).toMatchObject({ ok: true });
    await tools.get("page.perceive")!.execute({});
  }
  expect(await registry().get("page.click")!.execute({ anchor: "e1" })).toMatchObject(compiled ? { ok: false, error: expect.stringContaining("Repeated browser cycle") } : {ok:true});
  expect(mutations).toBe(compiled ? 6 : 7);
});

it.each([false, true])("allows completion without a dedicated verification call (compiled: %s)", async (compiled) => {
  const tools = new Map(buildToolRegistry({ session: {} as RunSession, compiled,
    emit: async () => ({ outcome: "deduped" }),
  }).map(t => [t.name, t]));
  expect(tools.has("page.verify")).toBe(false);
  expect(await tools.get("done")!.execute({ result: "finished" })).toMatchObject({ ok: true });
});

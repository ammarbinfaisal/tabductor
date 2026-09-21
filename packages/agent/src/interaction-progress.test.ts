import { expect, it } from "vitest";
import { buildToolRegistry } from "./tools.js";
import type { RunSession } from "@tabductor/browser";

it("blocks alternating editor cycles even when each mutation is followed by perception", async () => {
  let open = false, mutations = 0;
  const perceive = async () => ({ url: "https://destination.test", title: "Records", text: open ? "editor" : "table", elements: [] });
  const session = { page: { perceive, click: async () => { open = true; mutations++; }, interact: async () => { open = false; mutations++; } }, resolveAnchor: () => "cell", snapshotId: () => "s1" } as unknown as RunSession;
  let value: unknown = null;
  const memory = { get: async () => value, set: async (v: unknown) => { value = v; } };
  const registry = () => new Map(buildToolRegistry({ session, memory, emit: async () => ({ outcome: "deduped" }) }).map(t => [t.name, t]));
  const tools = registry();
  for (let i = 0; i < 3; i++) {
    expect(await tools.get("page.click")!.execute({ anchor: "e1" })).toMatchObject({ ok: true });
    await tools.get("page.perceive")!.execute({});
    expect(await tools.get("page.press")!.execute({ key: "Escape" })).toMatchObject({ ok: true });
    await tools.get("page.perceive")!.execute({});
  }
  expect(await registry().get("page.click")!.execute({ anchor: "e1" })).toMatchObject({ ok: false, error: expect.stringContaining("Repeated browser cycle") });
  expect(mutations).toBe(6);
});

it("requires committed content as well as identity before recording a save", async () => {
  let committedText = "record-42", activeEditor = true, snapshot = 0, saved = 0;
  const url = "https://destination.test/records";
  const session = { page: { perceive: async () => ({ url, title: "Records", text: "record-42 required body", committedText, activeEditor, elements: [], snapshotId: String(++snapshot) }), url: () => url }, snapshotId: () => String(snapshot), resolveAnchor: () => undefined } as unknown as RunSession;
  const tools = new Map(buildToolRegistry({ session, emit: async () => ({ outcome: "deduped" }),
    verificationContext: { packet: { id: "record-42", body: "required body" }, mapping: { id: "d1", revision: 1, destinationKey: url, canonicalUrl: url, fields: [{ packetField: "id", label: "Name", location: "title" }, { packetField: "body", label: "Body", location: "property" }], identityField: "id", verificationFields: ["id", "body"], dedupe: "search-before-create" } },
    recordOutcome: async outcome => { expect(outcome.verification).toMatchObject({ destinationContractId: "d1", committed: true }); saved++; },
  }).map(t => [t.name, t]));
  const verify = () => tools.get("page.verify")!.execute({ recordKey: "record-42", urlIncludes: "destination.test" });
  expect(await verify()).toMatchObject({ ok: false });
  activeEditor = false;
  expect(await verify()).toMatchObject({ ok: false });
  committedText = "record-42 required body";
  expect(await verify()).toMatchObject({ ok: true });
  expect(await tools.get("record.outcome")!.execute({ status: "saved", reason: "Read committed content" })).toMatchObject({ ok: true });
  expect(saved).toBe(1);
});

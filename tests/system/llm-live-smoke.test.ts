import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLlm, providerFromEnv } from "@tabductor/agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The one test in this repo that is allowed to touch a real provider — guarded on either
 * key the two-provider adapter accepts, per the S4a deviation (CI holds neither, so this
 * suite never runs there; the roadmap's "no CI test touches a live LLM" rule is unaffected).
 * Trivial completion → the live path works at all; record → replay proves the transcript
 * format round-trips against a real response shape, not just the stubbed one in
 * `packages/agent`'s unit tests.
 */

const selected = providerFromEnv(process.env);

describe.skipIf(!selected)("live LLM smoke", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tabductor-live-llm-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("completes live, records a transcript, and replays it", async () => {
    const { provider, apiKey } = selected!;
    const fixturePath = join(dir, "smoke.jsonl");

    const recorder = createLlm("record", { provider, apiKey, fixturePath });
    const live = await recorder.complete({
      system: "Reply with exactly the word: pong",
      messages: [{ role: "user", content: "ping" }],
      tools: [],
    });

    expect(live.text?.toLowerCase()).toContain("pong");
    expect(live.usage.in).toBeGreaterThan(0);
    expect(live.usage.out).toBeGreaterThan(0);

    const replayed = await createLlm("replay", { fixturePath }).complete({
      system: "Reply with exactly the word: pong",
      messages: [{ role: "user", content: "ping" }],
      tools: [],
    });
    expect(replayed).toEqual(live);
  });
});

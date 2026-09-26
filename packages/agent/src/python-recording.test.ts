import { expect, it } from "vitest";
import { pythonFixture } from "./python-test-support.js";

it.each([
  { type: "text", origin: "https://fixture.test", expected: false },
  { type: "password", origin: "https://fixture.test", expected: true },
  { type: "text", origin: "https://foreign.test", expected: true },
])("classifies $type input from $origin before dispatching recording-sensitive operations", async ({ type, origin, expected }) => {
  const fixture = pythonFixture();
  const original = fixture.session.page.proxy!;
  const recording: Array<{ member: string; private: boolean | undefined }> = [];
  fixture.session.page.proxy = async (command, options) => {
    if (command.command === "inspect") return { type, origin, pageOrigin: "https://fixture.test" };
    if (command.command === "call") recording.push({ member: command.call!.member, private: options.recordingPrivate });
    return original(command, options);
  };
  expect(await fixture.tool().execute({ source: "page.evaluate('() => document.title')\npage.locator('input').fill('fixture value')\npage.evaluate('() => document.title')" })).toMatchObject({ ok: true });
  expect(recording).toEqual([
    { member: "evaluate", private: false },
    { member: "locator", private: false },
    { member: "fill", private: expected },
    { member: "evaluate", private: expected },
  ]);
});

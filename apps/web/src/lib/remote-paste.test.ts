import { expect, it, vi } from "vitest";
import { attachRemotePaste } from "./remote-paste.js";

function fixture() {
  const target = new EventTarget() as HTMLElement;
  const options = { enabled: vi.fn(() => true), paste: vi.fn(async (_text: string) => {}), report: vi.fn() };
  const detach = attachRemotePaste(target, options);
  const paste = (text: string) => {
    const event = new Event("paste", { cancelable: true });
    Object.assign(event, { clipboardData: { getData: () => text } });
    target.dispatchEvent(event);
    return event;
  };
  return { target, options, detach, paste };
}

it.each([{ ctrlKey: true, code: "KeyV" }, { metaKey: true, code: "KeyV" }, { shiftKey: true, code: "Insert" }])("preserves the native paste gesture %j", keys => {
  const { target, detach } = fixture();
  const event = new Event("keydown", { cancelable: true });
  const stop = vi.spyOn(event, "stopPropagation");
  Object.assign(event, keys);
  target.dispatchEvent(event);
  expect(stop).toHaveBeenCalledOnce();
  expect(event.defaultPrevented).toBe(false);
  detach();
});

it("transfers multiline Unicode text once and preserves paste order", async () => {
  const { options, paste } = fixture();
  let finish!: () => void;
  options.paste.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  expect(paste("hello\nمرحبا 🌍").defaultPrevented).toBe(true);
  paste("second");
  await vi.waitFor(() => expect(options.paste).toHaveBeenCalledTimes(1));
  finish();
  await vi.waitFor(() => expect(options.paste).toHaveBeenCalledTimes(2));
  expect(options.paste.mock.calls.map(([text]) => text)).toEqual(["hello\nمرحبا 🌍", "second"]);
});

it("does not read the host clipboard while watching or disconnected", async () => {
  const { target, options } = fixture();
  options.enabled.mockReturnValue(false);
  const getData = vi.fn();
  const event = Object.assign(new Event("paste", { cancelable: true }), { clipboardData: { getData } });
  target.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(getData).not.toHaveBeenCalled();
  expect(options.paste).not.toHaveBeenCalled();
});

it("removes listeners and drops queued pastes after disconnect", async () => {
  const { options, paste, detach } = fixture();
  paste("queued");
  detach();
  expect(paste("after disconnect").defaultPrevented).toBe(false);
  await Promise.resolve();
  expect(options.paste).not.toHaveBeenCalled();
});

it("reports failure without automatically retrying a possibly applied paste", async () => {
  const { options, paste } = fixture();
  options.paste.mockRejectedValueOnce(new Error("revoked"));
  paste("first");
  await vi.waitFor(() => expect(options.report).toHaveBeenCalledOnce());
  expect(options.paste).toHaveBeenCalledTimes(1);
  paste("next explicit paste");
  await vi.waitFor(() => expect(options.paste).toHaveBeenCalledTimes(2));
});

it("ignores empty pastes and rejects oversized text before sending", async () => {
  const { options, paste } = fixture();
  paste("");
  paste("a".repeat(100_001));
  await vi.waitFor(() => expect(options.report).toHaveBeenCalledOnce());
  expect(options.paste).not.toHaveBeenCalled();
});

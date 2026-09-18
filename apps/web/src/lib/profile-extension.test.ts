import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, it, vi } from "vitest";
const source = readFileSync(new URL("../../../profile-extension/popup.js", import.meta.url), "utf8");
function extension() {
  const elements = Object.fromEntries(["code", "status", "target", "review", "sync"].map(id => [id, { value: "", textContent: "", hidden: false, disabled: false, listeners: {} as Record<string, () => Promise<void>>, addEventListener(event: string, listener: () => Promise<void>) { this.listeners[event] = listener; } }]));
  const cookie = { name: "session", value: "private-auth", domain: ".x.com", path: "/", session: true, httpOnly: true, secure: true, sameSite: "lax" };
  const chrome = { tabs: { query: vi.fn().mockResolvedValue([{ id: 1, url: "https://x.com/home" }]), get: vi.fn().mockResolvedValue({ url: "https://x.com/home" }) },
    permissions: { request: vi.fn().mockResolvedValue(true), remove: vi.fn().mockResolvedValue(true) },
    scripting: { executeScript: vi.fn().mockResolvedValue([{ result: { origin: "https://x.com", localStorage: [{ name: "unicode", value: "complete 状態" }, { name: "auth", value: "private-storage" }] } }]) },
    cookies: { getAllCookieStores: vi.fn().mockResolvedValue([{ id: "0", tabIds: [1] }]), getPartitionKey: vi.fn().mockResolvedValue({ partitionKey: { topLevelSite: "https://x.com" } }),
      getAll: vi.fn().mockResolvedValueOnce([cookie, { ...cookie, domain: "unrelated.com" }]).mockResolvedValue([]) } };
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ imported: true, cookies: 1, localStorageEntries: 2 }) });
  vm.runInNewContext(source, { document: { querySelector: (selector: string) => elements[selector.slice(1)] }, chrome, fetch, URL, Date, Error, SyntaxError });
  elements.code!.value = JSON.stringify({ server: "http://localhost:3000", origin: "https://x.com", token: "a".repeat(43), profileName: "Work", expiresAt: new Date(Date.now() + 60000).toISOString() });
  return { elements, chrome, fetch };
}
it("exports the selected origin only, including HttpOnly cookies and every storage entry, after review", async () => {
  const { elements, chrome, fetch } = extension();
  await elements.review!.listeners.click!();
  expect(fetch).not.toHaveBeenCalled();
  await elements.sync!.listeners.click!();
  const [url, request] = fetch.mock.calls[0]!;
  expect(url).toBe("http://localhost:3000/api/profile-import");
  expect(request.redirect).toBe("error");
  expect(JSON.parse(request.body)).toMatchObject({ cookies: [{ name: "session", value: "private-auth", httpOnly: true, expires: -1 }], localStorage: [{ name: "unicode", value: "complete 状態" }, { name: "auth", value: "private-storage" }] });
  expect(chrome.permissions.remove).toHaveBeenCalled();
  expect(elements.code!.value).toBe("");
});
it("sends nothing when the tab changes after review", async () => {
  const { elements, chrome, fetch } = extension();
  await elements.review!.listeners.click!();
  chrome.tabs.get.mockResolvedValue({ url: "https://unrelated.com" });
  await elements.sync!.listeners.click!();
  expect(fetch).not.toHaveBeenCalled();
  expect(chrome.permissions.remove).toHaveBeenCalled();
});
it("does not flatten partitioned authentication into ordinary cookies", async () => {
  const { elements, chrome, fetch } = extension();
  chrome.cookies.getAll.mockReset().mockResolvedValue([{ domain: ".x.com", partitionKey: { topLevelSite: "https://x.com" } }]);
  await elements.review!.listeners.click!(); await elements.sync!.listeners.click!();
  expect(fetch).not.toHaveBeenCalled();
  expect(elements.status!.textContent).toContain("partitioned cookies");
});

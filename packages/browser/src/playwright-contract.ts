import { readFileSync } from "node:fs";

export const PLAYWRIGHT_API_VERSION = "playwright-python-v1";
export type ProxyReference = { id: string; class: string; scope: string };
export type ProxyCall = { target: ProxyReference; member: string; args: unknown[]; kwargs: Record<string, unknown>; callback?: string; operationId?: string };
export type ProxyCallback = { id: string; callback: string; args: unknown[]; parentJob?: string };
export type ProxyOptions = { invocation: string; signal?: AbortSignal; recordingPrivate?: boolean; callback?: (event: ProxyCallback) => Promise<unknown> };
export type ProxyCommand = { command: "open" | "call" | "expect" | "inspect" | "close"; call?: ProxyCall; target?: ProxyReference; message?: string; timeout?: number; pin?: string };
export type ProxyMember = { property: boolean; kind: "read" | "effect" | "assertion" | "subscription"; parameters: Array<{name:string;kind:string;required:boolean}>; signature: string };
export const playwrightManifest = JSON.parse(readFileSync(new URL("../../../vendor/browser-harness/src/browser_harness/playwright_manifest.json", import.meta.url), "utf8")) as {
  version: string; playwright: string; classes: Record<string, Record<string, ProxyMember>>;
};
export function proxyMember(call: ProxyCall): ProxyMember {
  if (call.target.class === "EventContextManager" && ["enter", "exit", "value", "is_done"].includes(call.member))
    return {property:false,kind:"read",parameters:[],signature:call.member};
  const spec = playwrightManifest.classes[call.target.class]?.[call.member];
  if (!spec) throw new Error(`Unavailable Playwright member: ${call.target.class}.${call.member}`);
  return spec;
}

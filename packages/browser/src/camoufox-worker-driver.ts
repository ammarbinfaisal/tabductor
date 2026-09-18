import { randomUUID } from "node:crypto";
import type {
  BrowserConn,
  CreatePageOptions,
  Driver,
  ExtractSpec,
  NavigationOptions,
  NetworkRecord,
  NetworkBody,
  Page,
  PerceiveOptions,
  Perception,
  TargetProbe,
  WaitOptions,
} from "./driver.js";

const RPC_VERSION = "1";

export type CamoufoxWorkerDriverOptions = {
  token: string;
  sessionId: string;
  generation: number;
  fetch?: typeof globalThis.fetch;
};

type WorkerEvent = { sequence: number; kind: "request" | "settled" | "dialog"; page_id: string;
  request_id?: string; record?: NetworkRecord; dialog?: { type: string; message: string } };
type RpcResult<T> = { value: T; events?: WorkerEvent[]; event_cursor?: number };

export function createCamoufoxWorkerDriver(options: CamoufoxWorkerDriverOptions): Driver {
  const request = options.fetch ?? globalThis.fetch;

  return {
    async connect(workerUrl: string): Promise<BrowserConn> {
      const base = workerUrl.replace(/\/$/, "");
      let closed = false;
      const disconnected = new Set<() => void>();
      const pageHooks = new Map<string, CreatePageOptions>();
      const records = new Map<string, NetworkRecord>();
      let eventCursor = -1;
      let polling: ReturnType<typeof setTimeout> | undefined;
      let consuming: Promise<void> = Promise.resolve();

      const rpc = async <T>(method: string, pageId?: string, params: Record<string, unknown> = {}, consume = true): Promise<T> => {
        if (closed) throw new Error("camoufox worker connection is closed");
        let response: Response;
        try {
          response = await request(`${base}/v1/sessions/${encodeURIComponent(options.sessionId)}/commands`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${options.token}`,
              "content-type": "application/json",
              "x-tabductor-rpc-version": RPC_VERSION,
            },
            body: JSON.stringify({
              generation: options.generation,
              input_generation: 1,
              event_cursor: eventCursor,
              command_id: randomUUID(),
              method,
              ...(pageId ? { page_id: pageId } : {}),
              params,
            }),
          });
        } catch (error) {
          for (const callback of disconnected) callback();
          throw error;
        }
        if (!response.ok) {
          const detail = await response.text();
          if (response.status >= 500) for (const callback of disconnected) callback();
          throw new Error(`camoufox worker ${method} failed (${response.status}): ${detail.slice(0, 500)}`);
        }
        const result = await response.json() as RpcResult<T>;
        if (consume && result.events) {
          // Responses can arrive out of order. Serialize hooks and preserve the same record
          // identity between onStart and onSettled, while discarding duplicate feed entries.
          consuming = consuming.catch(() => undefined).then(async () => {
            for (const event of result.events!) {
              if (closed || event.sequence <= eventCursor) continue;
              eventCursor = event.sequence;
              const hooks = pageHooks.get(event.page_id);
              if (event.kind === "dialog" && event.dialog) { hooks?.onDialog?.(event.dialog); continue; }
              if (!event.request_id || !event.record) continue;
              if (event.kind === "request") {
                records.set(event.request_id, event.record);
                await hooks?.network?.onStart?.(event.record);
              } else {
                const record = records.get(event.request_id);
                if (!record) continue;
                Object.assign(record, event.record);
                const part = <P>(name: string) => rpc<P>("network.part", undefined, { request_id: event.request_id, part: name }, false);
                const body = async (name: string): Promise<NetworkBody | null> => {
                  const value = await part<{ bytes: string; mime: string } | null>(name);
                  return value ? { bytes: Buffer.from(value.bytes, "base64"), mime: value.mime } : null;
                };
                await hooks?.network?.onSettled?.(record, {
                  requestHeaders: () => part("requestHeaders"), requestBody: () => body("requestBody"),
                  responseHeaders: () => part("responseHeaders"), responseBody: async () => {
                    const value = await body("responseBody");
                    if (!value) throw new Error("network response body unavailable");
                    return value;
                  },
                });
              }
            }
            eventCursor = Math.max(eventCursor, result.event_cursor ?? -1);
          });
          await consuming;
        }
        return result.value;
      };
      const startPolling = () => {
        if (polling || closed) return;
        polling = setTimeout(async () => {
          polling = undefined;
          if (closed) return;
          try { await rpc("browser.events"); } catch { /* Takeover fences reads until fresh perception after resume. */ }
          startPolling();
        }, 500);
        polling.unref?.();
      };

      const pageOf = (pageId: string, hooks: CreatePageOptions): Page => {
        let currentUrl = "about:blank";
        return {
          id: pageId,
          async goto(url: string, opts: NavigationOptions = {}) {
            if (hooks.onNavigationRequest && !await hooks.onNavigationRequest({ url, cause: "initial" })) {
              throw new Error("navigation denied by runtime safety policy");
            }
            await rpc("page.goto", pageId, {
              url,
              ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
              ...(opts.waitUntil === undefined ? {} : { wait_until: opts.waitUntil }),
            });
            currentUrl = url;
          },
          click: (selector) => rpc("page.click", pageId, { selector }),
          type: (selector, text) => rpc("page.type", pageId, { selector, text }),
          waitFor: (selector: string, opts: WaitOptions = {}) => rpc("page.wait_for", pageId, {
            selector,
            ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
            ...(opts.state === undefined ? {} : { state: opts.state }),
          }),
          waitForLoadState: (state, opts = {}) => rpc("page.wait_for_load_state", pageId, {
            state,
            ...(opts.timeout === undefined ? {} : { timeout: opts.timeout }),
          }),
          queryAll: (selector: string, fields: ExtractSpec) => rpc("page.query_all", pageId, { selector, fields }),
          probeTarget: (selector: string) => rpc<TargetProbe | null>("page.probe", pageId, { selector }),
          insertTextRaw: (selector: string, text: string) => rpc("page.insert_text", pageId, { selector, text }),
          async perceive(opts: PerceiveOptions = {}): Promise<Perception> {
            const result = await rpc<Perception>("page.perceive", pageId, {
              ...(opts.maxChars === undefined ? {} : { max_chars: opts.maxChars }),
            });
            currentUrl = result.url;
            return result;
          },
          upload: (selector, file) => rpc("page.upload", pageId, {
            selector,
            name: file.name,
            mime_type: file.mimeType,
            bytes: file.bytes.toString("base64"),
          }),
          scroll: (direction) => rpc("page.scroll", pageId, { direction }),
          async screenshot() {
            return Buffer.from(await rpc<string>("page.screenshot", pageId), "base64");
          },
          title: () => rpc("page.title", pageId),
          url: () => currentUrl,
          close: () => rpc("page.close", pageId),
        };
      };

      return {
        async createPage(hooks = {}) {
          const created = await rpc<{ page_id: string }>("page.create");
          pageHooks.set(created.page_id, hooks);
          if (hooks.network || hooks.onDialog) startPolling();
          return pageOf(created.page_id, hooks);
        },
        version: () => rpc("browser.version"),
        onDisconnect: (callback) => { disconnected.add(callback); },
        async close() { closed = true; clearTimeout(polling); await consuming.catch(() => undefined); },
      };
    },
  };
}

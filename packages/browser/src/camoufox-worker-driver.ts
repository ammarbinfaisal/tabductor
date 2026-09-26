import { AppError } from "@tabductor/core";
import { randomUUID } from "node:crypto";
import type { ProxyCallback } from "./playwright-contract.js";
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
  /** Reuse the primary page for this exclusively leased workflow tab. */
  tabKey?: string;
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
        if (closed) throw new AppError("browser.disconnected", "camoufox worker connection is closed");
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
          if (error instanceof AppError) throw error;
          for (const callback of disconnected) callback();
          throw new AppError("browser.disconnected", "Browser transport failed; reconcile in-flight effects before retrying", { cause: error });
        }
        if (!response.ok) {
          const detail = await response.text();
          let parsed: { code?: string; message?: string; outcomeUncertain?: boolean } = {};
          try { parsed = (JSON.parse(detail) as { detail: typeof parsed }).detail ?? {}; } catch { /* Older worker. */ }
          const code = parsed.code ?? (response.status === 409 && /ownership|input owner/.test(detail) ? "browser_input_revoked" : "browser_command_failed");
          if (code === "browser.disconnected") for (const callback of disconnected) callback();
          throw new AppError(code, parsed.message ?? `Browser command ${method} failed (HTTP ${response.status}); inspect the current page before retrying`,
            { details: { method, status: response.status, outcomeUncertain: parsed.outcomeUncertain ?? true } });
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
              if (!hooks) continue;
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

      const pageOf = (pageId: string, hooks: CreatePageOptions, retained = false, url = "about:blank", rootPageId = pageId): Page => {
        let currentUrl = url;
        return {
          id: pageId,
          async proxy(command, opts) {
            const send = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
              const response = await request(`${base}/v1/sessions/${encodeURIComponent(options.sessionId)}/automation`, {
                method:"POST", headers:{authorization:`Bearer ${options.token}`,"content-type":"application/json","x-tabductor-rpc-version":RPC_VERSION},
                signal: command.command === "close" ? AbortSignal.timeout(5000) : opts.signal,
                body:JSON.stringify({generation:options.generation,input_generation:1,command_id:randomUUID(),page_id:rootPageId,method,
                  params:{...params,invocation:opts.invocation}}),
              });
              if (!response.ok) {
                const body = await response.json().catch(() => ({})) as {detail?:{code?:string;message?:string;outcomeUncertain?:boolean}|string};
                const detail = typeof body.detail === "object" ? body.detail : {};
                const legacyOwnership = response.status === 409 && typeof body.detail === "string" && /ownership|input owner/.test(body.detail);
                const code = detail.code ?? (legacyOwnership ? "browser_input_revoked" : "browser_command_failed");
                throw new AppError(code,
                  detail.message ?? `Browser proxy ${method} failed (HTTP ${response.status}); inspect the page before retrying`,
                  {details:{method,status:response.status,outcomeUncertain:detail.outcomeUncertain ?? true}});
              }
              return ((await response.json()) as {value:T}).value;
            };
            if (command.command !== "call") return send(command.command,{target:command.target,message:command.message,timeout:command.timeout,call:command.call,pin:command.pin});
            const call = command.call!;
            if (["goto", "go_back", "go_forward"].includes(call.member) && call.member === "goto") {
              const destination = String(call.args[0] ?? call.kwargs.url);
              if (hooks.onNavigationRequest && !await hooks.onNavigationRequest({url:destination,cause:"initial"}))
                throw new AppError("navigation_denied","Navigation denied",{details:{outcomeUncertain:false}});
            }
            const { ticket } = await send<{ticket:string}>("start",{...call,
              ...(opts.recordingPrivate === undefined ? {} : { recording_private: opts.recordingPrivate })});
            const pending = new Set<Promise<void>>();
            let callbackError: unknown;
            for (;;) {
              opts.signal?.throwIfAborted();
              const reply = await send<{pending:boolean;events:ProxyCallback[];result?:{ok:boolean;value?:unknown;code?:string;error?:string;outcomeUncertain?:boolean}}>("poll",{ticket});
              for (const event of reply.events) {
                const task = (async () => {
                  let result;
                  try { if (!opts.callback) throw new Error("Callback transport unavailable"); result={ok:true,value:await opts.callback(event)}; }
                  catch(error) {result={ok:false,error:String(error)};}
                  await send("callback",{ticket:event.id,result});
                })().catch(error => {callbackError=error;});
                pending.add(task); void task.finally(() => pending.delete(task));
              }
              if (callbackError) throw callbackError;
              if (!reply.pending) {
                await Promise.all(pending);
                if (!reply.result?.ok) throw new AppError(reply.result?.code ?? "browser_proxy_error",reply.result?.error ?? "Browser operation failed",
                  {details:{outcomeUncertain:reply.result?.outcomeUncertain ?? true}});
                if (call.member === "goto") currentUrl=String(call.args[0] ?? call.kwargs.url);
                return reply.result.value;
              }
            }
          },
          harness: (method, args) => rpc("page.harness", pageId, { method, args }),
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
          queryAll: (selector, fields, opts) => rpc("page.query_all", pageId, { selector, fields, ...opts }),
          probeTarget: (selector: string) => rpc<TargetProbe | null>("page.probe", pageId, { selector }),
          insertTextRaw: (selector: string, text: string) => rpc("page.insert_text", pageId, { selector, text }),
          async perceive(opts: PerceiveOptions = {}): Promise<Perception> {
            const result = await rpc<Perception>("page.perceive", pageId, {
              ...opts,
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
          async screenshot(opts) {
            return Buffer.from(await rpc<string>("page.screenshot", pageId, opts), "base64");
          },
          interact: (action) => rpc("page.interact", pageId, action),
          async download(selector) {
            const file = await rpc<{ name: string; mime: string; bytes: string }>("page.download", pageId, { selector });
            return { ...file, bytes: Buffer.from(file.bytes, "base64") };
          },
          // A successful OAuth flow may close the selected popup. Tab discovery and
          // ownership checks must remain anchored to the run's original tab.
          tabs: () => rpc("page.tabs", rootPageId),
          async switchTab(id) {
            const selected = await rpc<{page_id: string; url: string}>("page.switch_tab", rootPageId, {id});
            return pageOf(selected.page_id, hooks, true, selected.url, rootPageId);
          },
          title: () => rpc("page.title", pageId),
          url: () => currentUrl,
          async close() {
            pageHooks.delete(pageId);
            if (!retained) await rpc("page.close", pageId);
          },
        };
      };

      let primaryCreated = false;
      return {
        async createPage(hooks = {}) {
          const retained = options.tabKey !== undefined && !primaryCreated;
          const created = await rpc<{ page_id: string; url?: string }>(retained ? "tab.acquire" : "page.create", undefined,
            retained ? { tab_key: options.tabKey! } : {});
          primaryCreated = true;
          pageHooks.set(created.page_id, hooks);
          if (hooks.network || hooks.onDialog) startPolling();
          return pageOf(created.page_id, hooks, retained, created.url);
        },
        version: () => rpc("browser.version"),
        onDisconnect: (callback) => { disconnected.add(callback); },
        async close() { closed = true; clearTimeout(polling); await consuming.catch(() => undefined); },
      };
    },
  };
}

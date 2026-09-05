"use client";

import { createStore } from "zustand/vanilla";
import type { RouterOutputs } from "../lib/api.js";
import { api, asApiError } from "../lib/api.js";
import { relativeTime } from "../lib/relative-time.js";
import { useStoreBridge } from "../lib/store.js";

/**
 * MCP server registration (U3a). Registered servers' tools appear in every asset node's
 * registry on its next run — per-task allowlists are S7. The config JSON here is transport
 * config only; a credential is named (`secretName` → a `secrets` row), never pasted.
 */

type Servers = RouterOutputs["mcp"]["list"];

type State = {
  servers: Servers;
  label: string;
  transport: "stdio" | "http";
  configJson: string;
  secretName: string;
  busy: boolean;
  error: string | null;
  loaded: boolean;
};

const PLACEHOLDERS: Record<"stdio" | "http", string> = {
  stdio: '{ "command": "npx", "args": ["-y", "some-mcp-server"], "env": {} }',
  http: '{ "url": "https://mcp.example.com/mcp" }',
};

const store = createStore<State>(() => ({
  servers: [],
  label: "",
  transport: "stdio",
  configJson: "",
  secretName: "",
  busy: false,
  error: null,
  loaded: false,
}));

async function load(): Promise<void> {
  try {
    store.setState({ servers: await api.mcp.list.query(), error: null });
  } catch (err) {
    store.setState({ error: asApiError(err).message });
  }
}

async function act(fn: () => Promise<void>): Promise<void> {
  store.setState({ busy: true, error: null });
  try {
    await fn();
    store.setState({ busy: false });
  } catch (err) {
    store.setState({ busy: false, error: asApiError(err).message });
  }
  await load();
}

export function McpSettings() {
  if (!store.getState().loaded) {
    store.setState({ loaded: true });
    void load();
  }
  const state = useStoreBridge(store);

  return (
    <>
      <h1>MCP servers</h1>
      <p className="muted">
        Tools these servers expose become callable by every asset node&apos;s agent as{" "}
        <code>mcp.&lt;label&gt;.&lt;tool&gt;</code> on its next run. A server that needs a credential
        names a secret; the value is injected host-side and never enters a prompt.
      </p>

      {state.error ? <div className="banner banner-error">{state.error}</div> : null}

      {state.servers.length === 0 ? (
        <p className="muted">No servers registered.</p>
      ) : (
        <div className="ruled">
          {state.servers.map((s) => (
            <div key={s.id} className="row row--between">
              <span className="row">
                <span>{s.label}</span>
                <span className="chip mono">{s.transport}</span>
                {s.secretName ? (
                  <span className="mono muted" style={{ fontSize: "var(--text-xs)" }}>
                    secret: {s.secretName}
                  </span>
                ) : null}
              </span>
              <span className="row">
                <span className="mono muted" style={{ fontSize: "var(--text-xs)" }}>
                  added {relativeTime(s.createdAt)}
                </span>
                <button
                  disabled={state.busy}
                  onClick={() => void act(async () => void (await api.mcp.remove.mutate({ id: s.id })))}
                >
                  Remove
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      <section>
        <h3>Add a server</h3>
        <div className="row">
          <label className="field">
            <span>Label</span>
            <input value={state.label} placeholder="imagegen" onChange={(e) => store.setState({ label: e.target.value })} />
          </label>
          <label className="field">
            <span>Transport</span>
            <select
              value={state.transport}
              onChange={(e) => store.setState({ transport: e.target.value as "stdio" | "http" })}
            >
              <option value="stdio">stdio</option>
              <option value="http">http</option>
            </select>
          </label>
          <label className="field">
            <span>Secret name (optional)</span>
            <input
              value={state.secretName}
              placeholder="imagegen-api-key"
              onChange={(e) => store.setState({ secretName: e.target.value })}
            />
          </label>
        </div>
        <label className="field">
          <span>Config JSON</span>
          <textarea
            className="mono"
            rows={4}
            style={{ width: "100%", fontSize: "var(--text-sm)" }}
            value={state.configJson}
            placeholder={PLACEHOLDERS[state.transport]}
            onChange={(e) => store.setState({ configJson: e.target.value })}
          />
        </label>
        <button
          disabled={state.busy || !state.label.trim() || !state.configJson.trim()}
          onClick={() =>
            void act(async () => {
              const { label, transport, configJson, secretName } = store.getState();
              let parsed: unknown;
              try {
                parsed = JSON.parse(configJson);
              } catch {
                throw new Error("config is not valid JSON");
              }
              await api.mcp.create.mutate({
                label: label.trim(),
                transport,
                configJson: parsed as Record<string, unknown>,
                ...(secretName.trim() ? { secretName: secretName.trim() } : {}),
              });
              store.setState({ label: "", configJson: "", secretName: "" });
            })
          }
        >
          Add server
        </button>
      </section>
    </>
  );
}

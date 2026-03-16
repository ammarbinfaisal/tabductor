export const appConfig = {
  name: "@browsermcp/mcp",
} as const;

export const mcpConfig = {
  defaultWsPort: Number(process.env.BROWSERMCP_WS_PORT ?? "8765"),
  defaultControlPort: Number(process.env.BROWSERMCP_CONTROL_PORT ?? "8766"),
  defaultHost: process.env.BROWSERMCP_HOST ?? "127.0.0.1",
  errors: {
    noConnectedTab: "NO_CONNECTED_TAB",
    staleRef: "STALE_REF",
  },
} as const;

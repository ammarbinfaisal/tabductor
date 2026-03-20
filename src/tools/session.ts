import { randomUUID } from "node:crypto";

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { mcpConfig } from "@/config";
import type {
  BrowserConsoleEntry,
  BrowserConsoleEntryNotification,
  BrowserRunJsResult,
} from "@/protocol/messages";
import type { BrowserSessionState } from "@/session";
import {
  captureActionables,
  captureAriaSnapshot,
  captureSessionOverview,
  getDiscoveryState,
  renderDiscoverySelection,
  selectActionables,
} from "@/utils/aria-snapshot";

import type { Context } from "@/context";
import type { Tool, ToolCallExtra, ToolResult } from "./tool";

const sessionIdSchema = z
  .string()
  .uuid()
  .describe("Session ID from tabductor_sessions.");

const pageVersionSchema = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe(
    "Page version when this ref was captured from a prior Tabductor discovery result. " +
      "If provided and the page has changed since, the response includes fresh next-step refs for retrying.",
  );

const commonDiscoveryFilters = {
  query: z
    .string()
    .min(1)
    .optional()
    .describe("Optional text filter applied across names, values, hrefs, placeholders, and nearby context."),
  exact: z
    .boolean()
    .optional()
    .describe("When true, query matching uses exact case-insensitive field equality instead of substring matching."),
  roles: z
    .array(z.string().min(1))
    .optional()
    .describe("Optional role filter such as link, button, textbox, or combobox."),
  inViewportOnly: z
    .boolean()
    .optional()
    .describe("When true, only refs currently in the viewport are returned."),
  groupQuery: z
    .string()
    .min(1)
    .optional()
    .describe("Optional filter applied to group labels and contextual headings."),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("Maximum number of refs to return."),
  maxRefsPerGroup: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe("Maximum number of refs to return from any one semantic group."),
};

const browserSessionsArgs = z.object({});

const browserStateArgs = z.object({
  sessionId: sessionIdSchema,
});

const snapshotArgs = z.object({
  sessionId: sessionIdSchema,
});

const actionablesArgs = z.object({
  sessionId: sessionIdSchema,
  ...commonDiscoveryFilters,
});

const overviewArgs = z.object({
  sessionId: sessionIdSchema,
});

const navigateArgs = z.object({
  sessionId: sessionIdSchema,
  url: z.string().min(1).describe("URL to navigate to."),
  waitUntil: z
    .enum(["none", "url-change", "page-change", "settle"])
    .optional()
    .describe("How long Tabductor should wait before returning. Default is url-change."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(30000)
    .optional()
    .describe("Maximum time to wait for navigation observation."),
});

const clickArgs = z.object({
  sessionId: sessionIdSchema,
  element: z
    .string()
    .optional()
    .describe("Human-readable element description used for permission prompts."),
  ref: z.string().describe("Exact element reference from a prior Tabductor discovery result."),
  pageVersion: pageVersionSchema,
});

const hoverArgs = z.object({
  sessionId: sessionIdSchema,
  element: z
    .string()
    .optional()
    .describe("Human-readable element description used for permission prompts."),
  ref: z.string().describe("Exact element reference from a prior Tabductor discovery result."),
  pageVersion: pageVersionSchema,
});

const typeArgs = z.object({
  sessionId: sessionIdSchema,
  element: z
    .string()
    .optional()
    .describe("Human-readable element description used for permission prompts."),
  ref: z.string().describe("Exact editable element reference from a prior Tabductor discovery result."),
  text: z.string().describe("Text to type."),
  submit: z.boolean().describe("Whether to press Enter after typing."),
  pageVersion: pageVersionSchema,
});

const selectOptionArgs = z.object({
  sessionId: sessionIdSchema,
  element: z
    .string()
    .optional()
    .describe("Human-readable element description used for permission prompts."),
  ref: z.string().describe("Exact select element reference from a prior Tabductor discovery result."),
  values: z.array(z.string()).min(1).describe("Option values to select."),
  pageVersion: pageVersionSchema,
});

const goBackArgs = z.object({
  sessionId: sessionIdSchema,
});

const goForwardArgs = z.object({
  sessionId: sessionIdSchema,
});

const pressKeyArgs = z.object({
  sessionId: sessionIdSchema,
  key: z.string().describe("Key to press, such as Enter or ArrowLeft."),
});

const waitArgs = z.object({
  sessionId: sessionIdSchema,
  time: z.number().nonnegative().describe("Time to wait in seconds."),
});

const getConsoleLogsArgs = z.object({
  sessionId: sessionIdSchema,
});

const runJsArgs = z.object({
  sessionId: sessionIdSchema,
  code: z
    .string()
    .min(1)
    .describe(
      "JavaScript function body to execute inside the page as an async snippet. Use this as a local batching primitive when the model needs custom in-page logic across many elements or records, such as discover/filter/validate/plan/apply flows that would otherwise require many separate MCP calls. The snippet can use `window`, `document`, `args`, `tabductor` helper methods, and `console.log/info/warn/error`. `return` a JSON-serializable value.",
    ),
  args: z
    .unknown()
    .optional()
    .describe("Optional JSON-serializable input passed to the snippet as `args`."),
  pageVersion: pageVersionSchema,
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(120000)
    .optional()
    .describe("Maximum time to allow the snippet to run before failing."),
});

const screenshotArgs = z.object({
  sessionId: sessionIdSchema,
});

const fetchImageArgs = z.object({
  sessionId: sessionIdSchema,
  url: z.string().describe("Absolute URL of the image to fetch (e.g. the src of an <img> element)."),
});

const describeRefArgs = z.object({
  sessionId: sessionIdSchema,
  ref: z.string().describe("Element ref from any prior Tabductor discovery result."),
});

const findTextArgs = z.object({
  sessionId: sessionIdSchema,
  query: z
    .string()
    .min(1)
    .describe("Text to search for when choosing actionable refs on the current page."),
  exact: z
    .boolean()
    .optional()
    .describe("When true, query matching uses exact case-insensitive equality instead of substring matching."),
  roles: z
    .array(z.string().min(1))
    .optional()
    .describe("Optional hard role filter such as link, button, textbox, or combobox."),
  inViewportOnly: z
    .boolean()
    .optional()
    .describe("When true, only actionable refs currently in the viewport are considered."),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("Maximum number of actionable matches to return."),
  maxRefsPerGroup: z
    .number()
    .int()
    .positive()
    .max(25)
    .optional()
    .describe("Maximum number of matches to return from any one semantic group."),
  preferVisible: z
    .boolean()
    .optional()
    .describe("When true, visible actionable refs are ranked higher."),
  preferRoles: z
    .array(z.string().min(1))
    .optional()
    .describe("Optional soft ranking preference for roles such as link or button."),
  preferHrefContains: z
    .string()
    .min(1)
    .optional()
    .describe("Optional soft ranking preference for actionable hrefs containing this substring."),
});

const clickTextArgs = z.object({
  sessionId: sessionIdSchema,
  query: z
    .string()
    .min(1)
    .describe("Visible text or accessible name to click on the current page."),
  exact: z
    .boolean()
    .optional()
    .describe("When true, query matching uses exact case-insensitive equality instead of substring matching."),
  roles: z
    .array(z.string().min(1))
    .optional()
    .describe("Optional hard role filter such as button, link, tab, or menuitem."),
  inViewportOnly: z
    .boolean()
    .optional()
    .describe("When true, only actionable refs currently in the viewport are considered."),
  preferVisible: z
    .boolean()
    .optional()
    .describe("When true, visible actionable refs are ranked higher."),
  preferRoles: z
    .array(z.string().min(1))
    .optional()
    .describe("Optional soft ranking preference for roles such as button or link."),
  preferHrefContains: z
    .string()
    .min(1)
    .optional()
    .describe("Optional soft ranking preference for actionable hrefs containing this substring."),
});

const typeTextArgs = z.object({
  sessionId: sessionIdSchema,
  query: z
    .string()
    .min(1)
    .describe("Label, placeholder, or nearby text for the field to type into."),
  text: z.string().describe("Text to type."),
  submit: z.boolean().optional().describe("Whether to press Enter after typing."),
  exact: z
    .boolean()
    .optional()
    .describe("When true, query matching uses exact case-insensitive equality instead of substring matching."),
  inViewportOnly: z
    .boolean()
    .optional()
    .describe("When true, only actionable refs currently in the viewport are considered."),
  preferVisible: z
    .boolean()
    .optional()
    .describe("When true, visible actionable refs are ranked higher."),
});

function textResult(
  text: string,
  structuredContent: Record<string, unknown>,
): ToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

function isStaleRefError(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith(mcpConfig.errors.staleRef);
}

function formatActionTarget(ref: string, element?: string): string {
  return element ? `"${element}"` : `ref "${ref}"`;
}

async function getNextDiscoverySelection(
  context: Context,
  sessionId: string,
) {
  const discovery = await getDiscoveryState(context, sessionId, {
    preferCache: true,
  });
  return selectActionables(
    discovery,
    {},
    {
      limit: 12,
      maxRefsPerGroup: 4,
    },
  );
}

async function staleRefResult(
  context: Context,
  sessionId: string,
  ref: string,
  pageVersion: number | undefined,
): Promise<ToolResult> {
  const nextDiscovery = await getNextDiscoverySelection(context, sessionId);
  return {
    content: [
      {
        type: "text",
        text: [
          `Action failed: ref "${ref}" is stale.`,
          pageVersion != null
            ? `Page has changed since page version ${pageVersion}.`
            : "Page has changed since this ref was captured.",
          `Fresh next-step refs for page version ${nextDiscovery.pageVersion} are attached below.`,
          ...renderDiscoverySelection(nextDiscovery, {
            headingLabel: "Retry With These Refs",
          }),
        ].join("\n"),
      },
    ],
    isError: true,
    structuredContent: {
      error: mcpConfig.errors.staleRef,
      ref,
      pageVersion,
      nextDiscovery,
      nextRefs: nextDiscovery.recommendedActionables,
    },
  };
}

async function stalePageVersionResult(
  context: Context,
  sessionId: string,
  pageVersion: number | undefined,
): Promise<ToolResult> {
  const nextDiscovery = await getNextDiscoverySelection(context, sessionId);
  return {
    content: [
      {
        type: "text",
        text: [
          "Action failed: the supplied pageVersion is stale.",
          pageVersion != null
            ? `Page has changed since page version ${pageVersion}.`
            : "Page has changed since this action plan was prepared.",
          `Fresh next-step refs for page version ${nextDiscovery.pageVersion} are attached below.`,
          ...renderDiscoverySelection(nextDiscovery, {
            headingLabel: "Retry With These Refs",
          }),
        ].join("\n"),
      },
    ],
    isError: true,
    structuredContent: {
      error: mcpConfig.errors.staleRef,
      pageVersion,
      nextDiscovery,
      nextRefs: nextDiscovery.recommendedActionables,
    },
  };
}

function formatChangeLines(sessionState: BrowserSessionState): string[] {
  const change = sessionState.lastChange;
  if (!change) {
    return ["Page Changes: none reported"];
  }

  const lines = [
    `Page Changes: version ${change.fromVersion ?? "?"} -> ${change.toVersion}`,
  ];
  if (change.reason) {
    lines.push(`Change Reason: ${change.reason}`);
  }
  if (change.scope) {
    lines.push(`Change Scope: ${change.scope}`);
  }
  if (change.summary) {
    lines.push(`Change Summary: ${change.summary}`);
  }
  if (change.updated.length) {
    lines.push(
      `Updated Refs: ${change.updated
        .map((node) => node.ref ?? node.nodeId)
        .join(", ")}`,
    );
  }
  if (change.added.length) {
    lines.push(
      `Added Refs: ${change.added.map((node) => node.ref ?? node.nodeId).join(", ")}`,
    );
  }
  if (change.removed.length) {
    lines.push(
      `Removed Refs: ${change.removed
        .map((node) => node.ref ?? node.nodeId)
        .join(", ")}`,
    );
  }
  return lines;
}

function compactSessionState(session: BrowserSessionState) {
  return {
    sessionId: session.sessionId,
    connectedAt: session.connectedAt,
    status: session.status,
    page: session.page,
    pageVersion: session.pageVersion,
    capabilities: session.capabilities,
    extensionVersion: session.extensionVersion,
    browserName: session.browserName,
    userAgent: session.userAgent,
  };
}

function formatConsoleEntry(entry: BrowserConsoleEntry): string {
  return [
    entry.timestamp,
    entry.level.toUpperCase(),
    entry.source ? `[${entry.source}]` : null,
    entry.args.join(" "),
  ]
    .filter(Boolean)
    .join(" ");
}

function renderJson(value: unknown): string {
  if (value == null) {
    return String(value);
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

type DiscoveryActionTarget = {
  ref: string;
  role?: string;
  name?: string;
  actions: string[];
};

function summarizeTarget(target: DiscoveryActionTarget) {
  return `${target.ref}${target.name ? ` (${target.name})` : ""}${target.role ? ` [${target.role}]` : ""}`;
}

function resolveTextDiscoveryFilters(
  filters: {
    query: string;
    exact?: boolean;
    roles?: string[];
    inViewportOnly?: boolean;
    preferVisible?: boolean;
    preferRoles?: string[];
    preferHrefContains?: string;
  },
  defaults: {
    preferRoles?: string[];
  } = {},
) {
  return {
    query: filters.query,
    exact: filters.exact,
    roles: filters.roles,
    inViewportOnly: filters.inViewportOnly,
    preferVisible: filters.preferVisible,
    preferRoles: filters.preferRoles ?? defaults.preferRoles,
    preferHrefContains: filters.preferHrefContains,
  };
}

async function resolveActionableByText(
  context: Context,
  sessionId: string,
  filters: {
    query: string;
    exact?: boolean;
    roles?: string[];
    inViewportOnly?: boolean;
    preferVisible?: boolean;
    preferRoles?: string[];
    preferHrefContains?: string;
  },
  options: {
    headingLabel: string;
    preferRoles?: string[];
    predicate?: (target: DiscoveryActionTarget) => boolean;
  },
): Promise<
  | {
      ok: true;
      target: DiscoveryActionTarget;
      selection: Awaited<ReturnType<typeof selectActionables>>;
    }
  | {
      ok: false;
      result: ToolResult;
    }
> {
  const discovery = await getDiscoveryState(context, sessionId, {
    preferCache: false,
  });
  const selection = selectActionables(
    discovery,
    resolveTextDiscoveryFilters(filters, {
      preferRoles: options.preferRoles,
    }),
    {
      limit: 12,
      maxRefsPerGroup: 4,
      preferVisible: true,
    },
  );

  const target = selection.actionables.find((entry) =>
    options.predicate
      ? options.predicate({
          ref: entry.ref,
          role: entry.role,
          name: entry.name,
          actions: entry.actions,
        })
      : true,
  );

  if (!target) {
    return {
      ok: false,
      result: {
        content: [
          {
            type: "text",
            text: [
              `No actionable ref matched "${filters.query}" for ${options.headingLabel.toLowerCase()}.`,
              ...renderDiscoverySelection(selection, {
                headingLabel: "Closest Matches",
              }),
            ].join("\n"),
          },
        ],
        isError: true,
        structuredContent: {
          error: "NO_MATCH",
          sessionId,
          query: filters.query,
          pageVersion: selection.pageVersion,
          selection,
          matches: selection.actionables,
          recommendedRef: selection.recommendedRef ?? null,
        },
      },
    };
  }

  return {
    ok: true,
    target: {
      ref: target.ref,
      role: target.role,
      name: target.name,
      actions: target.actions,
    },
    selection,
  };
}

async function emitProgressMessage(
  extra: ToolCallExtra | undefined,
  progress: number,
  message: string,
) {
  if (!extra) {
    return;
  }
  const progressToken = extra?._meta?.progressToken;
  if (progressToken == null) {
    return;
  }

  await extra.sendNotification({
    method: "notifications/progress",
    params: {
      progressToken,
      progress,
      message,
    },
  });
}

async function actionResult(
  context: Context,
  options: {
    action: string;
    sessionId: string;
    successText: string;
    beforeRevision: number;
    beforePageVersion: number | null;
    input?: Record<string, unknown>;
    waitTimeoutMs?: number;
  },
): Promise<ToolResult> {
  const {
    action,
    sessionId,
    successText,
    beforeRevision,
    beforePageVersion,
    input,
    waitTimeoutMs,
  } = options;
  const changed = await context.waitForStateChangeSince(
    sessionId,
    beforeRevision,
    waitTimeoutMs,
  );
  const sessionState = await context.getSessionState(sessionId);
  const lines = [successText, ...formatChangeLines(sessionState)];
  let nextDiscovery: Awaited<ReturnType<typeof getNextDiscoverySelection>> | null = null;
  const pageVersionChanged = sessionState.pageVersion !== beforePageVersion;

  lines.push(`Current URL: ${sessionState.page?.url ?? "unknown"}`);
  lines.push(`Current Title: ${sessionState.page?.title ?? "unknown"}`);
  lines.push(`Transport Connected: ${sessionState.status === "ready" ? "yes" : "no"}`);

  if (pageVersionChanged && sessionState.pageVersion != null && sessionState.status === "ready") {
    try {
      nextDiscovery = await getNextDiscoverySelection(context, sessionId);
      lines.push(
        `Fresh next-step refs attached for page version ${nextDiscovery.pageVersion}.`,
      );
      lines.push(
        ...renderDiscoverySelection(nextDiscovery, {
          headingLabel: "Next Actionable Areas",
        }),
      );
    } catch {
      lines.push("Page version changed, but Tabductor could not capture the refreshed next-step refs.");
    }
  } else {
    lines.push(`Page Version: ${sessionState.pageVersion ?? "unknown"}`);
    lines.push("No refreshed next-step refs were needed.");
  }

  if (!changed) {
    lines.push("No observable page-state change was reported before the tool timeout.");
  }
  return textResult(
    lines.join("\n"),
    {
      action,
      input,
      session: sessionState,
      pageVersion: sessionState.pageVersion,
      pageVersionChanged,
      currentUrl: sessionState.page?.url ?? null,
      currentTitle: sessionState.page?.title ?? null,
      transportConnected: sessionState.status === "ready",
      ...(nextDiscovery
        ? {
            nextDiscovery,
            nextRefs: nextDiscovery.recommendedActionables,
          }
        : {}),
    },
  );
}

async function waitForNavigationState(
  context: Context,
  sessionId: string,
  options: {
    beforeRevision: number;
    beforeUrl: string | null;
    beforePageVersion: number | null;
    waitUntil: "none" | "url-change" | "page-change" | "settle";
    timeoutMs: number;
  },
): Promise<{
  sessionState: BrowserSessionState;
  urlChanged: boolean;
  pageVersionChanged: boolean;
  stateChanged: boolean;
  navigationObserved: boolean;
  timedOut: boolean;
}> {
  const { beforeRevision, beforeUrl, beforePageVersion, waitUntil, timeoutMs } = options;
  let currentRevision = beforeRevision;
  let sessionState = await context.getSessionState(sessionId);
  let timedOut = false;

  const readOutcome = () => {
    const urlChanged = (sessionState.page?.url ?? null) !== beforeUrl;
    const pageVersionChanged = sessionState.pageVersion !== beforePageVersion;
    const stateChanged = urlChanged || pageVersionChanged;
    return {
      sessionState,
      urlChanged,
      pageVersionChanged,
      stateChanged,
      navigationObserved: stateChanged,
      timedOut,
    };
  };

  if (waitUntil === "none") {
    return readOutcome();
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    sessionState = await context.getSessionState(sessionId);
    const outcome = readOutcome();

    if (waitUntil === "url-change" && outcome.urlChanged) {
      return outcome;
    }
    if (waitUntil === "page-change" && outcome.stateChanged) {
      return outcome;
    }
    if (waitUntil === "settle" && outcome.stateChanged) {
      const remaining = Math.max(1, deadline - Date.now());
      const settled = await context.waitForStateChangeSince(
        sessionId,
        await context.getStateRevision(sessionId),
        Math.min(400, remaining),
      );
      sessionState = await context.getSessionState(sessionId);
      if (!settled) {
        return readOutcome();
      }
      currentRevision = await context.getStateRevision(sessionId);
      continue;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    const changed = await context.waitForStateChangeSince(
      sessionId,
      currentRevision,
      Math.min(300, remaining),
    );
    if (changed) {
      currentRevision = await context.getStateRevision(sessionId);
    }
  }

  timedOut = true;
  sessionState = await context.getSessionState(sessionId);
  return readOutcome();
}

async function navigateResult(
  context: Context,
  options: {
    sessionId: string;
    url: string;
    beforeRevision: number;
    beforePageVersion: number | null;
    beforeUrl: string | null;
    waitUntil: "none" | "url-change" | "page-change" | "settle";
    timeoutMs: number;
  },
): Promise<ToolResult> {
  const {
    sessionId,
    url,
    beforeRevision,
    beforePageVersion,
    beforeUrl,
    waitUntil,
    timeoutMs,
  } = options;
  const outcome = await waitForNavigationState(context, sessionId, {
    beforeRevision,
    beforeUrl,
    beforePageVersion,
    waitUntil,
    timeoutMs,
  });

  let nextDiscovery: Awaited<ReturnType<typeof getNextDiscoverySelection>> | null = null;
  if (
    outcome.pageVersionChanged &&
    outcome.sessionState.pageVersion != null &&
    outcome.sessionState.status === "ready"
  ) {
    try {
      nextDiscovery = await getNextDiscoverySelection(context, sessionId);
    } catch {
      nextDiscovery = null;
    }
  }

  const lines = [
    `Navigation requested to ${url}`,
    `Wait Strategy: ${waitUntil}`,
    `Navigation Observed: ${outcome.navigationObserved ? "yes" : "no"}`,
    `Current URL: ${outcome.sessionState.page?.url ?? "unknown"}`,
    `Current Title: ${outcome.sessionState.page?.title ?? "unknown"}`,
    `Transport Connected: ${outcome.sessionState.status === "ready" ? "yes" : "no"}`,
    ...formatChangeLines(outcome.sessionState),
  ];

  if (nextDiscovery) {
    lines.push(`Fresh next-step refs attached for page version ${nextDiscovery.pageVersion}.`);
    lines.push(
      ...renderDiscoverySelection(nextDiscovery, {
        headingLabel: "Next Actionable Areas",
      }),
    );
  }

  if (outcome.timedOut) {
    lines.push("Navigation wait timed out before the requested condition was observed.");
  }

  return textResult(lines.join("\n"), {
    action: "navigate",
    input: {
      url,
      waitUntil,
      timeoutMs,
    },
    session: outcome.sessionState,
    navigationObserved: outcome.navigationObserved,
    urlChanged: outcome.urlChanged,
    pageVersionChanged: outcome.pageVersionChanged,
    currentUrl: outcome.sessionState.page?.url ?? null,
    currentTitle: outcome.sessionState.page?.title ?? null,
    transportConnected: outcome.sessionState.status === "ready",
    timedOut: outcome.timedOut,
    ...(nextDiscovery
      ? {
          nextDiscovery,
          nextRefs: nextDiscovery.recommendedActionables,
        }
      : {}),
  });
}

export const listSessions: Tool = {
  schema: {
    name: "tabductor_sessions",
    description:
      "List connected browser sessions and their latest known metadata, capabilities, page info, and current page version.",
    inputSchema: zodToJsonSchema(browserSessionsArgs),
  },
  handle: async (context) => {
    const sessionStates = await context.listSessions();
    if (!sessionStates.length) {
      return textResult("No connected browser sessions.", { sessions: [] });
    }

    const text = [
      "Connected browser sessions:",
      ...sessionStates.map(
        (session) =>
          `- ${session.sessionId} | ${session.status} | v${session.pageVersion ?? "?"} | ${session.page?.title ?? "unknown"} | ${session.page?.url ?? "unknown"}`,
      ),
    ].join("\n");

    return textResult(text, {
      sessions: sessionStates.map(compactSessionState),
    });
  },
};

export const state: Tool = {
  schema: {
    name: "tabductor_state",
    description:
      "Read the latest known server-side state for one browser session, including page metadata, page version, capabilities, and last change summary.",
    inputSchema: zodToJsonSchema(browserStateArgs),
  },
  handle: async (context, params) => {
    const { sessionId } = browserStateArgs.parse(params ?? {});
    const sessionState = await context.getSessionState(sessionId);
    const text = [
      `Session: ${sessionState.sessionId}`,
      `Status: ${sessionState.status}`,
      `Page Version: ${sessionState.pageVersion ?? "unknown"}`,
      `Page URL: ${sessionState.page?.url ?? "unknown"}`,
      `Page Title: ${sessionState.page?.title ?? "unknown"}`,
      ...formatChangeLines(sessionState),
    ].join("\n");
    return textResult(text, { session: sessionState });
  },
};

export const snapshot: Tool = {
  schema: {
    name: "tabductor_snapshot",
    description:
      "Return a compact semantic snapshot for one browser session. This is not a full DOM or full URL inventory; use tabductor_actionables, tabductor_find_text, or tabductor_describe_ref when you need targeted elaboration.",
    inputSchema: zodToJsonSchema(snapshotArgs),
  },
  handle: async (context, params) => {
    const { sessionId } = snapshotArgs.parse(params ?? {});
    return captureAriaSnapshot(context, sessionId);
  },
};

export const actionables: Tool = {
  schema: {
    name: "tabductor_actionables",
    description:
      "Return the best actionable refs for one browser session, grouped and bounded by semantic area. Use filters to target the exact next clicks or form controls you need.",
    inputSchema: zodToJsonSchema(actionablesArgs),
  },
  handle: async (context, params) => {
    const { sessionId, ...filters } = actionablesArgs.parse(params ?? {});
    return captureActionables(context, sessionId, filters);
  },
};

export const overview: Tool = {
  schema: {
    name: "tabductor_session_overview",
    description:
      "Return a compact LLM-oriented overview for one browser session, summarizing interactive areas, grouped refs, and page context before deeper inspection.",
    inputSchema: zodToJsonSchema(overviewArgs),
  },
  handle: async (context, params) => {
    const { sessionId } = overviewArgs.parse(params ?? {});
    return captureSessionOverview(context, sessionId);
  },
};

export const navigate: Tool = {
  schema: {
    name: "tabductor_navigate",
    description:
      "Navigate one browser session to a URL and wait until a requested navigation condition is observed.",
    inputSchema: zodToJsonSchema(navigateArgs),
  },
  handle: async (context, params) => {
    const {
      sessionId,
      url,
      waitUntil = "url-change",
      timeoutMs = 5000,
    } = navigateArgs.parse(params ?? {});
    const beforeState = await context.getSessionState(sessionId);
    const beforeRevision = await context.getStateRevision(sessionId);
    const beforePageVersion = beforeState.pageVersion;
    await context.sendSocketMessage("tabductor_navigate", { url }, undefined, sessionId);
    return navigateResult(context, {
      sessionId,
      url,
      beforeRevision,
      beforePageVersion,
      beforeUrl: beforeState.page?.url ?? null,
      waitUntil,
      timeoutMs,
    });
  },
};

export const click: Tool = {
  schema: {
    name: "tabductor_click",
    description:
      "Click an element in one browser session. Pass a ref from prior Tabductor discovery. `element` is optional metadata; `pageVersion` is optional strict stale-ref protection.",
    inputSchema: zodToJsonSchema(clickArgs),
  },
  handle: async (context, params) => {
    const { sessionId, pageVersion, ...clickParams } = clickArgs.parse(params ?? {});
    const beforeRevision = await context.getStateRevision(sessionId);
    const beforePageVersion = (await context.getSessionState(sessionId)).pageVersion;
    try {
      await context.sendSocketMessage(
        "tabductor_click",
        {
          ...clickParams,
          ...(pageVersion !== undefined ? { expectedVersion: pageVersion } : {}),
        },
        undefined,
        sessionId,
      );
    } catch (e) {
      if (isStaleRefError(e)) {
        return await staleRefResult(context, sessionId, clickParams.ref, pageVersion);
      }
      throw e;
    }
    return actionResult(context, {
      action: "click",
      beforeRevision,
      beforePageVersion,
      input: clickParams,
      sessionId,
      successText: `Clicked ${formatActionTarget(clickParams.ref, clickParams.element)} in session ${sessionId}`,
    });
  },
};

export const clickText: Tool = {
  schema: {
    name: "tabductor_click_text",
    description:
      "Find the best current actionable match for a text query and click it in one step. Prefer this when the intent is 'click the button/link/tab named X' and you do not want to manage refs manually.",
    inputSchema: zodToJsonSchema(clickTextArgs),
  },
  handle: async (context, params) => {
    const { sessionId, ...filters } = clickTextArgs.parse(params ?? {});
    const beforeRevision = await context.getStateRevision(sessionId);
    const beforePageVersion = (await context.getSessionState(sessionId)).pageVersion;

    const resolved = await resolveActionableByText(context, sessionId, filters, {
      headingLabel: "Click",
      preferRoles: ["button", "link", "tab", "menuitem"],
      predicate: (target) => target.actions.includes("click"),
    });
    if (!resolved.ok) {
      return resolved.result;
    }

    let target = resolved.target;
    try {
      await context.sendSocketMessage(
        "tabductor_click",
        { ref: target.ref },
        undefined,
        sessionId,
      );
    } catch (e) {
      if (!isStaleRefError(e)) {
        throw e;
      }

      const retry = await resolveActionableByText(context, sessionId, filters, {
        headingLabel: "Click",
        preferRoles: ["button", "link", "tab", "menuitem"],
        predicate: (entry) => entry.actions.includes("click"),
      });
      if (!retry.ok) {
        return retry.result;
      }
      target = retry.target;
      await context.sendSocketMessage(
        "tabductor_click",
        { ref: target.ref },
        undefined,
        sessionId,
      );
    }

    return actionResult(context, {
      action: "click_text",
      beforeRevision,
      beforePageVersion,
      input: {
        query: filters.query,
        resolvedRef: target.ref,
      },
      sessionId,
      successText: `Clicked best match for "${filters.query}" via ${summarizeTarget(target)} in session ${sessionId}`,
    });
  },
};

export const hover: Tool = {
  schema: {
    name: "tabductor_hover",
    description:
      "Hover an element in one browser session. Pass a ref from prior Tabductor discovery. `element` is optional metadata; `pageVersion` is optional strict stale-ref protection.",
    inputSchema: zodToJsonSchema(hoverArgs),
  },
  handle: async (context, params) => {
    const { sessionId, pageVersion, ...hoverParams } = hoverArgs.parse(params ?? {});
    const beforeRevision = await context.getStateRevision(sessionId);
    const beforePageVersion = (await context.getSessionState(sessionId)).pageVersion;
    try {
      await context.sendSocketMessage(
        "tabductor_hover",
        {
          ...hoverParams,
          ...(pageVersion !== undefined ? { expectedVersion: pageVersion } : {}),
        },
        undefined,
        sessionId,
      );
    } catch (e) {
      if (isStaleRefError(e)) {
        return await staleRefResult(context, sessionId, hoverParams.ref, pageVersion);
      }
      throw e;
    }
    return actionResult(context, {
      action: "hover",
      beforeRevision,
      beforePageVersion,
      input: hoverParams,
      sessionId,
      successText: `Hovered over ${formatActionTarget(hoverParams.ref, hoverParams.element)} in session ${sessionId}`,
    });
  },
};

export const type: Tool = {
  schema: {
    name: "tabductor_type",
    description:
      "Type into an element in one browser session. Pass a ref from prior Tabductor discovery. `element` is optional metadata; `pageVersion` is optional strict stale-ref protection.",
    inputSchema: zodToJsonSchema(typeArgs),
  },
  handle: async (context, params) => {
    const { sessionId, pageVersion, ...typeParams } = typeArgs.parse(params ?? {});
    const beforeRevision = await context.getStateRevision(sessionId);
    const beforePageVersion = (await context.getSessionState(sessionId)).pageVersion;
    try {
      await context.sendSocketMessage(
        "tabductor_type",
        {
          ...typeParams,
          ...(pageVersion !== undefined ? { expectedVersion: pageVersion } : {}),
        },
        undefined,
        sessionId,
      );
    } catch (e) {
      if (isStaleRefError(e)) {
        return await staleRefResult(context, sessionId, typeParams.ref, pageVersion);
      }
      throw e;
    }
    return actionResult(context, {
      action: "type",
      beforeRevision,
      beforePageVersion,
      input: typeParams,
      sessionId,
      successText: `Typed "${typeParams.text}" into ${formatActionTarget(typeParams.ref, typeParams.element)} in session ${sessionId}`,
    });
  },
};

export const typeText: Tool = {
  schema: {
    name: "tabductor_type_text",
    description:
      "Find the best current field match for a text query and type into it in one step. Prefer this when the intent is 'type into the field labeled X' and you do not want to manage refs manually.",
    inputSchema: zodToJsonSchema(typeTextArgs),
  },
  handle: async (context, params) => {
    const {
      sessionId,
      text,
      submit = false,
      ...filters
    } = typeTextArgs.parse(params ?? {});
    const beforeRevision = await context.getStateRevision(sessionId);
    const beforePageVersion = (await context.getSessionState(sessionId)).pageVersion;

    const resolved = await resolveActionableByText(context, sessionId, filters, {
      headingLabel: "Type",
      preferRoles: ["textbox", "combobox"],
      predicate: (target) => target.actions.includes("type"),
    });
    if (!resolved.ok) {
      return resolved.result;
    }

    let target = resolved.target;
    try {
      await context.sendSocketMessage(
        "tabductor_type",
        { ref: target.ref, text, submit },
        undefined,
        sessionId,
      );
    } catch (e) {
      if (!isStaleRefError(e)) {
        throw e;
      }

      const retry = await resolveActionableByText(context, sessionId, filters, {
        headingLabel: "Type",
        preferRoles: ["textbox", "combobox"],
        predicate: (entry) => entry.actions.includes("type"),
      });
      if (!retry.ok) {
        return retry.result;
      }
      target = retry.target;
      await context.sendSocketMessage(
        "tabductor_type",
        { ref: target.ref, text, submit },
        undefined,
        sessionId,
      );
    }

    return actionResult(context, {
      action: "type_text",
      beforeRevision,
      beforePageVersion,
      input: {
        query: filters.query,
        text,
        submit,
        resolvedRef: target.ref,
      },
      sessionId,
      successText: `Typed into best match for "${filters.query}" via ${summarizeTarget(target)} in session ${sessionId}`,
    });
  },
};

export const selectOption: Tool = {
  schema: {
    name: "tabductor_select_option",
    description:
      "Select one or more options in one browser session. Pass a ref from prior Tabductor discovery. `element` is optional metadata; `pageVersion` is optional strict stale-ref protection.",
    inputSchema: zodToJsonSchema(selectOptionArgs),
  },
  handle: async (context, params) => {
    const { sessionId, pageVersion, ...selectParams } = selectOptionArgs.parse(
      params ?? {},
    );
    const beforeRevision = await context.getStateRevision(sessionId);
    const beforePageVersion = (await context.getSessionState(sessionId)).pageVersion;
    try {
      await context.sendSocketMessage(
        "tabductor_select_option",
        {
          ...selectParams,
          ...(pageVersion !== undefined ? { expectedVersion: pageVersion } : {}),
        },
        undefined,
        sessionId,
      );
    } catch (e) {
      if (isStaleRefError(e)) {
        return await staleRefResult(context, sessionId, selectParams.ref, pageVersion);
      }
      throw e;
    }
    return actionResult(context, {
      action: "select_option",
      beforeRevision,
      beforePageVersion,
      input: selectParams,
      sessionId,
      successText: `Selected option in ${formatActionTarget(selectParams.ref, selectParams.element)} in session ${sessionId}`,
    });
  },
};

export const goBack: Tool = {
  schema: {
    name: "tabductor_go_back",
    description: "Navigate back in one browser session.",
    inputSchema: zodToJsonSchema(goBackArgs),
  },
  handle: async (context, params) => {
    const { sessionId } = goBackArgs.parse(params ?? {});
    const beforeRevision = await context.getStateRevision(sessionId);
    const beforePageVersion = (await context.getSessionState(sessionId)).pageVersion;
    await context.sendSocketMessage("tabductor_go_back", {}, undefined, sessionId);
    return actionResult(context, {
      action: "go_back",
      beforeRevision,
      beforePageVersion,
      sessionId,
      successText: `Navigated back in session ${sessionId}`,
      waitTimeoutMs: 5000,
    });
  },
};

export const goForward: Tool = {
  schema: {
    name: "tabductor_go_forward",
    description: "Navigate forward in one browser session.",
    inputSchema: zodToJsonSchema(goForwardArgs),
  },
  handle: async (context, params) => {
    const { sessionId } = goForwardArgs.parse(params ?? {});
    const beforeRevision = await context.getStateRevision(sessionId);
    const beforePageVersion = (await context.getSessionState(sessionId)).pageVersion;
    await context.sendSocketMessage("tabductor_go_forward", {}, undefined, sessionId);
    return actionResult(context, {
      action: "go_forward",
      beforeRevision,
      beforePageVersion,
      sessionId,
      successText: `Navigated forward in session ${sessionId}`,
      waitTimeoutMs: 5000,
    });
  },
};

export const pressKey: Tool = {
  schema: {
    name: "tabductor_press_key",
    description: "Press a key in one browser session.",
    inputSchema: zodToJsonSchema(pressKeyArgs),
  },
  handle: async (context, params) => {
    const { sessionId, key } = pressKeyArgs.parse(params ?? {});
    const beforeRevision = await context.getStateRevision(sessionId);
    const beforePageVersion = (await context.getSessionState(sessionId)).pageVersion;
    await context.sendSocketMessage(
      "tabductor_press_key",
      { key },
      undefined,
      sessionId,
    );
    return actionResult(context, {
      action: "press_key",
      beforeRevision,
      beforePageVersion,
      input: { key },
      sessionId,
      successText: `Pressed key ${key} in session ${sessionId}`,
    });
  },
};

export const wait: Tool = {
  schema: {
    name: "tabductor_wait",
    description: "Wait for a number of seconds in one browser session.",
    inputSchema: zodToJsonSchema(waitArgs),
  },
  handle: async (context, params) => {
    const { sessionId, time } = waitArgs.parse(params ?? {});
    const beforeRevision = await context.getStateRevision(sessionId);
    const beforePageVersion = (await context.getSessionState(sessionId)).pageVersion;
    await context.sendSocketMessage("tabductor_wait", { time }, undefined, sessionId);
    return actionResult(context, {
      action: "wait",
      beforeRevision,
      beforePageVersion,
      input: { time },
      sessionId,
      successText: `Waited for ${time} seconds in session ${sessionId}`,
    });
  },
};

export const getConsoleLogs: Tool = {
  schema: {
    name: "tabductor_console_logs",
    description: "Read console logs from one browser session.",
    inputSchema: zodToJsonSchema(getConsoleLogsArgs),
  },
  handle: async (context, params) => {
    const { sessionId } = getConsoleLogsArgs.parse(params ?? {});
    const consoleLogs = await context.sendSocketMessage(
      "tabductor_get_console_logs",
      {},
      undefined,
      sessionId,
    );
    const logs = consoleLogs.map(formatConsoleEntry);
    return textResult(logs.join("\n"), { logs: consoleLogs });
  },
};

export const runJs: Tool = {
  schema: {
    name: "tabductor_run_js",
    description:
      "Run an async JavaScript snippet inside one browser session. Use this as a page-local batching primitive when the model needs its own selection, filtering, validation, dry-run, or apply logic over many DOM targets or data records, and many small MCP calls would be wasteful. The snippet can inspect the page, build a candidate set, perform checks, optionally execute actions, and return a structured summary in one or two calls. It can use `window`, `document`, `args`, `tabductor` helpers, and `console.log/info/warn/error`; `return` a JSON-serializable value. Console output is streamed during execution when the client supports progress notifications and is always returned in the final result.",
    inputSchema: zodToJsonSchema(runJsArgs),
  },
  handle: async (context, params, extra) => {
    const {
      sessionId,
      code,
      args,
      pageVersion,
      timeoutMs = 30000,
    } = runJsArgs.parse(params ?? {});
    const runId = randomUUID();
    const beforeRevision = await context.getStateRevision(sessionId);
    const beforePageVersion = (await context.getSessionState(sessionId)).pageVersion;
    const streamedLogs: BrowserConsoleEntry[] = [];
    let progressCount = 0;

    await emitProgressMessage(
      extra,
      progressCount,
      `tabductor_run_js started for session ${sessionId}`,
    );

    const unsubscribe = await context.subscribeToTabductorNotifications(
      sessionId,
      (event, payload) => {
        if (event !== "tabductor.console.entry") {
          return;
        }
        const consolePayload = payload as BrowserConsoleEntryNotification;
        if (consolePayload.runId !== runId) {
          return;
        }
        streamedLogs.push(consolePayload.entry);
        progressCount += 1;
        void emitProgressMessage(
          extra,
          progressCount,
          `tabductor_run_js console: ${formatConsoleEntry(consolePayload.entry)}`,
        );
      },
    );

    let runResult: BrowserRunJsResult;
    try {
      runResult = await context.sendSocketMessage(
        "tabductor_run_js",
        {
          code,
          args,
          runId,
          timeoutMs,
          ...(pageVersion !== undefined ? { expectedVersion: pageVersion } : {}),
        },
        { timeoutMs: timeoutMs + 1000 },
        sessionId,
      );
    } catch (e) {
      await unsubscribe();
      if (isStaleRefError(e)) {
        return await stalePageVersionResult(context, sessionId, pageVersion);
      }
      throw e;
    }

    await unsubscribe();
    const stateResult = await actionResult(context, {
      action: "run_js",
      beforeRevision,
      beforePageVersion,
      input: {
        runId,
      },
      sessionId,
      successText: runResult.success
        ? `Executed JavaScript snippet in session ${sessionId}`
        : `JavaScript snippet failed in session ${sessionId}`,
    });
    const resultLogs = runResult.logs.length ? runResult.logs : streamedLogs;
    const stateText =
      stateResult.content.find((content) => content.type === "text")?.text ?? "";
    const lines = [
      `Run ID: ${runResult.runId ?? runId}`,
      `Duration: ${runResult.durationMs} ms`,
      runResult.success
        ? null
        : `Error: ${runResult.error?.message ?? "Unknown JavaScript execution failure"}`,
      runResult.result !== undefined
        ? `Return Value:\n${renderJson(runResult.result)}`
        : "Return Value: undefined",
      resultLogs.length
        ? `Console Logs:\n${resultLogs.map(formatConsoleEntry).join("\n")}`
        : "Console Logs: none",
      stateText,
    ].filter(Boolean);

    await emitProgressMessage(
      extra,
      progressCount + 1,
      runResult.success
        ? `tabductor_run_js completed for session ${sessionId}`
        : `tabductor_run_js failed for session ${sessionId}: ${runResult.error?.message ?? "unknown error"}`,
    );

    return {
      content: [{ type: "text", text: lines.join("\n\n") }],
      isError: !runResult.success,
      structuredContent: {
        ...(stateResult.structuredContent ?? {}),
        runId: runResult.runId ?? runId,
        run: runResult,
        logs: resultLogs,
      },
    };
  },
};

export const screenshot: Tool = {
  schema: {
    name: "tabductor_screenshot",
    description: "Capture a screenshot from one browser session.",
    inputSchema: zodToJsonSchema(screenshotArgs),
  },
  handle: async (context, params) => {
    const { sessionId } = screenshotArgs.parse(params ?? {});
    const screenshotData = await context.sendSocketMessage(
      "tabductor_screenshot",
      {},
      undefined,
      sessionId,
    );
    if (!screenshotData) {
      return {
        content: [
          {
            type: "text",
            text: "Screenshot capture failed: no image data returned from browser.",
          },
        ],
        isError: true,
        structuredContent: { error: "no_image_data" },
      };
    }
    return {
      content: [
        {
          type: "image",
          data: screenshotData,
          mimeType: "image/png",
        },
        {
          type: "text",
          text: `Screenshot captured for session ${sessionId} (image/png).`,
        },
      ],
    };
  },
};

export const fetchImage: Tool = {
  schema: {
    name: "tabductor_fetch_image",
    description:
      "Fetch an image by URL using the browser session and return it as an inline image. " +
      "Use this to retrieve images visible on the current page (e.g. from <img> src attributes) " +
      "so you can inspect or save them. The URL must be accessible from the browser's context.",
    inputSchema: zodToJsonSchema(fetchImageArgs),
  },
  handle: async (context, params) => {
    const { sessionId, url } = fetchImageArgs.parse(params ?? {});

    // Use tabductor_run_js to fetch the image as a base64 data URL
    const code = `
      const response = await fetch(${JSON.stringify(url)});
      if (!response.ok) throw new Error(\`HTTP \${response.status} fetching image\`);
      const contentType = response.headers.get('content-type') || 'image/png';
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      return { data: btoa(binary), mimeType: contentType };
    `;

    const runResult = await context.sendSocketMessage(
      "tabductor_run_js",
      { code },
      undefined,
      sessionId,
    );

    if (!runResult.success || runResult.result == null) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to fetch image: ${runResult.error?.message ?? "unknown error"}`,
          },
        ],
        isError: true,
      };
    }

    const { data, mimeType } = runResult.result as { data: string; mimeType: string };
    return {
      content: [
        {
          type: "image",
          data,
          mimeType,
        },
        {
          type: "text",
          text: `Fetched image from ${url} (${mimeType}).`,
        },
      ],
    };
  },
};

export const describeRef: Tool = {
  schema: {
    name: "tabductor_describe_ref",
    description:
      "Return detailed context for one element ref from any prior Tabductor discovery result.",
    inputSchema: zodToJsonSchema(describeRefArgs),
  },
  handle: async (context, params) => {
    const { sessionId, ref } = describeRefArgs.parse(params ?? {});
    const description = await context.sendSocketMessage(
      "tabductor_describe_ref",
      { ref },
      undefined,
      sessionId,
    );
    const text = [
      `Ref: ${description.ref}`,
      `Role: ${description.role ?? "unknown"}`,
      `Name: ${description.name ?? "unknown"}`,
      `Tag: ${description.htmlTag}`,
      description.context.landmark
        ? `Landmark: ${description.context.landmark}`
        : null,
      description.context.heading ? `Heading: ${description.context.heading}` : null,
      description.context.form ? `Form: ${description.context.form}` : null,
      description.text ? `Text: ${description.text}` : null,
      description.value ? `Value: ${description.value}` : null,
      description.description ? `Description: ${description.description}` : null,
      description.actions.length
        ? `Actions: ${description.actions.join(", ")}`
        : null,
      description.nearbyRefs.length
        ? `Nearby Refs: ${description.nearbyRefs
            .map((item) => `${item.ref}${item.name ? ` (${item.name})` : ""}`)
            .join(", ")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    return textResult(text, { description });
  },
};

export const findText: Tool = {
  schema: {
    name: "tabductor_find_text",
    description:
      "Find the best actionable refs matching a text query on the current page and return a recommended ref for the next action.",
    inputSchema: zodToJsonSchema(findTextArgs),
  },
  handle: async (context, params) => {
    const { sessionId, ...filters } = findTextArgs.parse(params ?? {});
    const discovery = await getDiscoveryState(context, sessionId, {
      preferCache: true,
    });
    const selection = selectActionables(
      discovery,
      filters,
      {
        limit: 12,
        maxRefsPerGroup: 4,
      },
    );

    if (!selection.returnedMatches) {
      return textResult(
        `No actionable refs matched "${filters.query}" on ${discovery.page.url}`,
        {
          sessionId,
          query: filters.query,
          pageVersion: discovery.pageVersion,
          recommendedRef: null,
          matches: [],
        },
      );
    }

    const lines = [
      `- Session ID: ${sessionId}`,
      `- Page URL: ${discovery.page.url}`,
      `- Page Title: ${discovery.page.title}`,
      ...renderDiscoverySelection(selection, {
        headingLabel: "Matching Actionable Areas",
      }),
    ];

    return textResult(lines.join("\n"), {
      sessionId,
      query: filters.query,
      pageVersion: discovery.pageVersion,
      recommendedRef: selection.recommendedRef,
      matches: selection.actionables,
      totalMatches: selection.totalMatches,
      returnedMatches: selection.returnedMatches,
      truncated: selection.truncated,
      groups: selection.groups,
    });
  },
};

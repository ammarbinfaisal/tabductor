import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { mcpConfig } from "@/config";
import type { BrowserSessionState } from "@/session";
import {
  captureActionables,
  captureAriaSnapshot,
  findTextInSnapshot,
  getSnapshotResponse,
} from "@/utils/aria-snapshot";

import type { Context } from "@/context";
import type { Tool, ToolResult } from "./tool";

const sessionIdSchema = z
  .string()
  .uuid()
  .describe("Session ID from browser_sessions.");

const snapshotVersionSchema = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe(
    "Snapshot version when this ref was captured (from browser_actionables or browser_snapshot). " +
      "If provided and the page has changed since, the action fails with STALE_REF so you can re-fetch actionables.",
  );

const browserSessionsArgs = z.object({});

const browserStateArgs = z.object({
  sessionId: sessionIdSchema,
});

const snapshotArgs = z.object({
  sessionId: sessionIdSchema,
});

const actionablesArgs = z.object({
  sessionId: sessionIdSchema,
});

const navigateArgs = z.object({
  sessionId: sessionIdSchema,
  url: z.string().min(1).describe("URL to navigate to."),
});

const clickArgs = z.object({
  sessionId: sessionIdSchema,
  element: z
    .string()
    .describe("Human-readable element description used for permission prompts."),
  ref: z.string().describe("Exact element reference from a prior snapshot."),
  snapshotVersion: snapshotVersionSchema,
});

const hoverArgs = z.object({
  sessionId: sessionIdSchema,
  element: z
    .string()
    .describe("Human-readable element description used for permission prompts."),
  ref: z.string().describe("Exact element reference from a prior snapshot."),
  snapshotVersion: snapshotVersionSchema,
});

const typeArgs = z.object({
  sessionId: sessionIdSchema,
  element: z
    .string()
    .describe("Human-readable element description used for permission prompts."),
  ref: z.string().describe("Exact editable element reference from a prior snapshot."),
  text: z.string().describe("Text to type."),
  submit: z.boolean().describe("Whether to press Enter after typing."),
  snapshotVersion: snapshotVersionSchema,
});

const selectOptionArgs = z.object({
  sessionId: sessionIdSchema,
  element: z
    .string()
    .describe("Human-readable element description used for permission prompts."),
  ref: z.string().describe("Exact select element reference from a prior snapshot."),
  values: z.array(z.string()).min(1).describe("Option values to select."),
  snapshotVersion: snapshotVersionSchema,
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

const screenshotArgs = z.object({
  sessionId: sessionIdSchema,
});

const describeRefArgs = z.object({
  sessionId: sessionIdSchema,
  ref: z.string().describe("Element ref from browser_snapshot."),
});

const findTextArgs = z.object({
  sessionId: sessionIdSchema,
  query: z
    .string()
    .min(1)
    .describe("Text to search for in the page (case-insensitive). Matches against element names, values, and href attributes."),
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

function staleRefResult(ref: string, snapshotVersion: number | undefined): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: [
          `Action failed: ref "${ref}" is stale.`,
          snapshotVersion != null
            ? `Page has changed since snapshot version ${snapshotVersion}.`
            : "Page has changed since this ref was captured.",
          "Call browser_actionables to get fresh refs before retrying.",
        ].join("\n"),
      },
    ],
    isError: true,
    structuredContent: { error: mcpConfig.errors.staleRef, ref, snapshotVersion },
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

async function actionResult(
  context: Context,
  options: {
    action: string;
    sessionId: string;
    successText: string;
    beforeRevision: number;
    input?: Record<string, unknown>;
    waitTimeoutMs?: number;
  },
): Promise<ToolResult> {
  const {
    action,
    sessionId,
    successText,
    beforeRevision,
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
  if (!changed) {
    lines.push("No observable page-state change was reported before the tool timeout.");
  }
  return textResult(
    lines.join("\n"),
    {
      action,
      input,
      session: sessionState,
    },
  );
}

export const listSessions: Tool = {
  schema: {
    name: "browser_sessions",
    description:
      "List connected browser sessions and their latest known metadata, capabilities, page info, and snapshot version.",
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
          `- ${session.sessionId} | ${session.status} | v${session.snapshotVersion ?? "?"} | ${session.page?.title ?? "unknown"} | ${session.page?.url ?? "unknown"}`,
      ),
    ].join("\n");

    return textResult(text, { sessions: sessionStates });
  },
};

export const state: Tool = {
  schema: {
    name: "browser_state",
    description:
      "Read the latest known server-side state for one browser session, including page metadata, snapshot version, capabilities, and last change summary.",
    inputSchema: zodToJsonSchema(browserStateArgs),
  },
  handle: async (context, params) => {
    const { sessionId } = browserStateArgs.parse(params ?? {});
    const sessionState = await context.getSessionState(sessionId);
    const text = [
      `Session: ${sessionState.sessionId}`,
      `Status: ${sessionState.status}`,
      `Snapshot Version: ${sessionState.snapshotVersion ?? "unknown"}`,
      `Page URL: ${sessionState.page?.url ?? "unknown"}`,
      `Page Title: ${sessionState.page?.title ?? "unknown"}`,
      ...formatChangeLines(sessionState),
    ].join("\n");
    return textResult(text, { session: sessionState });
  },
};

export const snapshot: Tool = {
  schema: {
    name: "browser_snapshot",
    description:
      "Return a compact current snapshot summary for one browser session. Prefer browser_actionables for lightweight ref discovery and browser_describe_ref for deeper detail on a specific ref.",
    inputSchema: zodToJsonSchema(snapshotArgs),
  },
  handle: async (context, params) => {
    const { sessionId } = snapshotArgs.parse(params ?? {});
    return captureAriaSnapshot(context, sessionId);
  },
};

export const actionables: Tool = {
  schema: {
    name: "browser_actionables",
    description:
      "Return all actionable refs from the current snapshot for one browser session. Use this as the default discovery step before browser_describe_ref or an action tool.",
    inputSchema: zodToJsonSchema(actionablesArgs),
  },
  handle: async (context, params) => {
    const { sessionId } = actionablesArgs.parse(params ?? {});
    return captureActionables(context, sessionId);
  },
};

export const navigate: Tool = {
  schema: {
    name: "browser_navigate",
    description:
      "Navigate one browser session to a URL. The MCP tracks cache invalidation and version changes automatically.",
    inputSchema: zodToJsonSchema(navigateArgs),
  },
  handle: async (context, params) => {
    const { sessionId, url } = navigateArgs.parse(params ?? {});
    const beforeRevision = await context.getStateRevision(sessionId);
    await context.sendSocketMessage("browser_navigate", { url }, undefined, sessionId);
    return actionResult(context, {
      action: "navigate",
      beforeRevision,
      input: { url },
      sessionId,
      successText: `Navigated session ${sessionId} to ${url}`,
      waitTimeoutMs: 5000,
    });
  },
};

export const click: Tool = {
  schema: {
    name: "browser_click",
    description:
      "Click an element in one browser session. Pass the ref from browser_snapshot; the MCP manages version preconditions and cache updates internally.",
    inputSchema: zodToJsonSchema(clickArgs),
  },
  handle: async (context, params) => {
    const { sessionId, snapshotVersion, ...clickParams } = clickArgs.parse(params ?? {});
    const beforeRevision = await context.getStateRevision(sessionId);
    try {
      await context.sendSocketMessage(
        "browser_click",
        {
          ...clickParams,
          ...(snapshotVersion !== undefined ? { expectedVersion: snapshotVersion } : {}),
        },
        undefined,
        sessionId,
      );
    } catch (e) {
      if (isStaleRefError(e)) return staleRefResult(clickParams.ref, snapshotVersion);
      throw e;
    }
    return actionResult(context, {
      action: "click",
      beforeRevision,
      input: clickParams,
      sessionId,
      successText: `Clicked "${clickParams.element}" in session ${sessionId}`,
    });
  },
};

export const hover: Tool = {
  schema: {
    name: "browser_hover",
    description:
      "Hover an element in one browser session. Pass the ref from browser_snapshot; the MCP manages cache updates internally.",
    inputSchema: zodToJsonSchema(hoverArgs),
  },
  handle: async (context, params) => {
    const { sessionId, snapshotVersion, ...hoverParams } = hoverArgs.parse(params ?? {});
    const beforeRevision = await context.getStateRevision(sessionId);
    try {
      await context.sendSocketMessage(
        "browser_hover",
        {
          ...hoverParams,
          ...(snapshotVersion !== undefined ? { expectedVersion: snapshotVersion } : {}),
        },
        undefined,
        sessionId,
      );
    } catch (e) {
      if (isStaleRefError(e)) return staleRefResult(hoverParams.ref, snapshotVersion);
      throw e;
    }
    return actionResult(context, {
      action: "hover",
      beforeRevision,
      input: hoverParams,
      sessionId,
      successText: `Hovered over "${hoverParams.element}" in session ${sessionId}`,
    });
  },
};

export const type: Tool = {
  schema: {
    name: "browser_type",
    description:
      "Type into an element in one browser session. Pass the ref from browser_snapshot; the MCP manages cache updates internally.",
    inputSchema: zodToJsonSchema(typeArgs),
  },
  handle: async (context, params) => {
    const { sessionId, snapshotVersion, ...typeParams } = typeArgs.parse(params ?? {});
    const beforeRevision = await context.getStateRevision(sessionId);
    try {
      await context.sendSocketMessage(
        "browser_type",
        {
          ...typeParams,
          ...(snapshotVersion !== undefined ? { expectedVersion: snapshotVersion } : {}),
        },
        undefined,
        sessionId,
      );
    } catch (e) {
      if (isStaleRefError(e)) return staleRefResult(typeParams.ref, snapshotVersion);
      throw e;
    }
    return actionResult(context, {
      action: "type",
      beforeRevision,
      input: typeParams,
      sessionId,
      successText: `Typed "${typeParams.text}" into "${typeParams.element}" in session ${sessionId}`,
    });
  },
};

export const selectOption: Tool = {
  schema: {
    name: "browser_select_option",
    description:
      "Select one or more options in one browser session. Pass the ref from browser_snapshot; the MCP manages cache updates internally.",
    inputSchema: zodToJsonSchema(selectOptionArgs),
  },
  handle: async (context, params) => {
    const { sessionId, snapshotVersion, ...selectParams } = selectOptionArgs.parse(
      params ?? {},
    );
    const beforeRevision = await context.getStateRevision(sessionId);
    try {
      await context.sendSocketMessage(
        "browser_select_option",
        {
          ...selectParams,
          ...(snapshotVersion !== undefined ? { expectedVersion: snapshotVersion } : {}),
        },
        undefined,
        sessionId,
      );
    } catch (e) {
      if (isStaleRefError(e)) return staleRefResult(selectParams.ref, snapshotVersion);
      throw e;
    }
    return actionResult(context, {
      action: "select_option",
      beforeRevision,
      input: selectParams,
      sessionId,
      successText: `Selected option in "${selectParams.element}" in session ${sessionId}`,
    });
  },
};

export const goBack: Tool = {
  schema: {
    name: "browser_go_back",
    description: "Navigate back in one browser session.",
    inputSchema: zodToJsonSchema(goBackArgs),
  },
  handle: async (context, params) => {
    const { sessionId } = goBackArgs.parse(params ?? {});
    const beforeRevision = await context.getStateRevision(sessionId);
    await context.sendSocketMessage("browser_go_back", {}, undefined, sessionId);
    return actionResult(context, {
      action: "go_back",
      beforeRevision,
      sessionId,
      successText: `Navigated back in session ${sessionId}`,
      waitTimeoutMs: 5000,
    });
  },
};

export const goForward: Tool = {
  schema: {
    name: "browser_go_forward",
    description: "Navigate forward in one browser session.",
    inputSchema: zodToJsonSchema(goForwardArgs),
  },
  handle: async (context, params) => {
    const { sessionId } = goForwardArgs.parse(params ?? {});
    const beforeRevision = await context.getStateRevision(sessionId);
    await context.sendSocketMessage("browser_go_forward", {}, undefined, sessionId);
    return actionResult(context, {
      action: "go_forward",
      beforeRevision,
      sessionId,
      successText: `Navigated forward in session ${sessionId}`,
      waitTimeoutMs: 5000,
    });
  },
};

export const pressKey: Tool = {
  schema: {
    name: "browser_press_key",
    description: "Press a key in one browser session.",
    inputSchema: zodToJsonSchema(pressKeyArgs),
  },
  handle: async (context, params) => {
    const { sessionId, key } = pressKeyArgs.parse(params ?? {});
    const beforeRevision = await context.getStateRevision(sessionId);
    await context.sendSocketMessage(
      "browser_press_key",
      { key },
      undefined,
      sessionId,
    );
    return actionResult(context, {
      action: "press_key",
      beforeRevision,
      input: { key },
      sessionId,
      successText: `Pressed key ${key} in session ${sessionId}`,
    });
  },
};

export const wait: Tool = {
  schema: {
    name: "browser_wait",
    description: "Wait for a number of seconds in one browser session.",
    inputSchema: zodToJsonSchema(waitArgs),
  },
  handle: async (context, params) => {
    const { sessionId, time } = waitArgs.parse(params ?? {});
    const beforeRevision = await context.getStateRevision(sessionId);
    await context.sendSocketMessage("browser_wait", { time }, undefined, sessionId);
    return actionResult(context, {
      action: "wait",
      beforeRevision,
      input: { time },
      sessionId,
      successText: `Waited for ${time} seconds in session ${sessionId}`,
    });
  },
};

export const getConsoleLogs: Tool = {
  schema: {
    name: "browser_console_logs",
    description: "Read console logs from one browser session.",
    inputSchema: zodToJsonSchema(getConsoleLogsArgs),
  },
  handle: async (context, params) => {
    const { sessionId } = getConsoleLogsArgs.parse(params ?? {});
    const consoleLogs = await context.sendSocketMessage(
      "browser_get_console_logs",
      {},
      undefined,
      sessionId,
    );
    const logs = consoleLogs.map((log: unknown) => JSON.stringify(log));
    return textResult(logs.join("\n"), { logs });
  },
};

export const screenshot: Tool = {
  schema: {
    name: "browser_screenshot",
    description: "Capture a screenshot from one browser session.",
    inputSchema: zodToJsonSchema(screenshotArgs),
  },
  handle: async (context, params) => {
    const { sessionId } = screenshotArgs.parse(params ?? {});
    const screenshotData = await context.sendSocketMessage(
      "browser_screenshot",
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
      structuredContent: {
        imageFormat: "png",
        sessionId,
      },
    };
  },
};

export const describeRef: Tool = {
  schema: {
    name: "browser_describe_ref",
    description:
      "Return detailed context for one element ref from browser_snapshot. Use this when a compact snapshot is insufficient.",
    inputSchema: zodToJsonSchema(describeRefArgs),
  },
  handle: async (context, params) => {
    const { sessionId, ref } = describeRefArgs.parse(params ?? {});
    const description = await context.sendSocketMessage(
      "browser_describe_ref",
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
    name: "browser_find_text",
    description:
      "Search the current page snapshot for elements matching a text query. Returns matching elements with their refs (if actionable) so you can act on them directly. Searches element names, values, and href attributes (case-insensitive).",
    inputSchema: zodToJsonSchema(findTextArgs),
  },
  handle: async (context, params) => {
    const { sessionId, query } = findTextArgs.parse(params ?? {});
    const snapshot = await getSnapshotResponse(context, sessionId, {
      preferCache: true,
    });
    const matches = findTextInSnapshot(snapshot, query);

    if (!matches.length) {
      return textResult(
        `No matches found for "${query}" on ${snapshot.page.url}`,
        { sessionId, query, matches: [] },
      );
    }

    const lines = [
      `- Session ID: ${sessionId}`,
      `- Query: "${query}"`,
      `- Matches: ${matches.length}`,
      ...matches.map((m) => {
        const parts = [
          m.ref ?? m.nodeId,
          m.role ?? "unknown",
          m.name ?? "unnamed",
        ];
        if (m.href) parts.push(m.href);
        if (m.ref) parts.push("actionable");
        parts.push(m.matchContext);
        return `- ${parts.join(" | ")}`;
      }),
    ];

    return textResult(lines.join("\n"), {
      sessionId,
      query,
      snapshotVersion: snapshot.snapshot.version,
      matches,
    });
  },
};

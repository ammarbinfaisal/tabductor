const DEFAULT_SERVER_URL = "ws://127.0.0.1:8765";
const CONNECTED_TABS_KEY = "tabductorConnectedTabs";
const SERVER_URL_KEY = "tabductorServerUrl";
const DEBUGGER_PROTOCOL_VERSION = "1.3";

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await clearConnectedTab(tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete") {
    return;
  }

  const connectedTabs = await getConnectedTabs();
  const serverUrl = connectedTabs[String(tabId)];
  if (!serverUrl) {
    return;
  }

  try {
    await ensureContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, {
      type: "tabductor:connect",
      serverUrl,
      tabInfo: toTabInfo((await chrome.tabs.get(tabId)) || { id: tabId }),
    });
  } catch (error) {
    console.error("Failed to reconnect Tabductor tab", error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleRuntimeMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: normalizeError(error),
      }),
    );
  return true;
});

async function handleRuntimeMessage(message, sender) {
  switch (normalizeRuntimeMessageType(message?.type)) {
    case "tabductor:popup-status":
      return getPopupStatus();
    case "tabductor:popup-connect-active-tab":
      return connectActiveTab();
    case "tabductor:popup-disconnect-active-tab":
      return disconnectActiveTab();
    case "tabductor:popup-disconnect-tab":
      await disconnectTabById(message.tabId);
      return { ok: true };
    case "tabductor:popup-set-server-url":
      await chrome.storage.local.set({ [SERVER_URL_KEY]: message.serverUrl });
      return { ok: true };
    case "tabductor:capture-screenshot":
      if (sender.tab?.id == null) {
        throw new Error("No sender tab for screenshot");
      }
      return {
        ok: true,
        data: await captureTabScreenshot(sender.tab.id),
      };
    case "tabductor:run-js":
      if (sender.tab?.id == null) {
        throw new Error("No sender tab for JavaScript execution");
      }
      return {
        ok: true,
        data: await executeRunJsInTab(sender.tab.id, message.payload || {}),
      };
    default:
      return { ok: false, error: "Unknown runtime message" };
  }
}

async function getPopupStatus() {
  const activeTab = await getActiveTab();
  const connectedTabs = await getConnectedTabs();
  const serverUrl = await getServerUrl();

  let tabStatus = null;
  if (activeTab?.id != null) {
    try {
      await ensureContentScript(activeTab.id);
      tabStatus = await chrome.tabs.sendMessage(activeTab.id, {
        type: "tabductor:status",
      });
    } catch (_error) {
      tabStatus = null;
    }
  }

  const connectedTabEntries = await Promise.all(
    Object.entries(connectedTabs).map(async ([tabIdText, tabServerUrl]) => {
      const tabId = Number(tabIdText);
      try {
        const tab = await chrome.tabs.get(tabId);
        await ensureContentScript(tabId);
        const status = await chrome.tabs.sendMessage(tabId, {
          type: "tabductor:status",
        });
        return {
          id: tabId,
          title: tab.title,
          url: tab.url,
          active: tab.active,
          windowId: tab.windowId,
          faviconUrl: tab.favIconUrl,
          serverUrl: tabServerUrl,
          status,
        };
      } catch (_error) {
        return {
          id: tabId,
          title: "(tab unavailable)",
          url: "",
          active: false,
          serverUrl: tabServerUrl,
          status: {
            connected: false,
            status: "disconnected",
          },
        };
      }
    }),
  );

  return {
    ok: true,
    activeTab: activeTab
      ? {
          id: activeTab.id,
          title: activeTab.title,
          url: activeTab.url,
        }
      : null,
    connected: Boolean(tabStatus?.connected),
    desiredConnected: Boolean(
      activeTab?.id != null && connectedTabs[String(activeTab.id)],
    ),
    connectedTabs: connectedTabEntries,
    connectedCount: connectedTabEntries.filter((tab) => tab.status?.connected).length,
    serverUrl,
    tabStatus,
  };
}

async function connectActiveTab() {
  const activeTab = await getActiveTab();
  if (!activeTab?.id) {
    throw new Error("No active tab");
  }

  await ensureConnectableTab(activeTab.id);
  await ensureContentScript(activeTab.id);

  const serverUrl = await getServerUrl();
  await setConnectedTab(activeTab.id, serverUrl);
  await chrome.tabs.sendMessage(activeTab.id, {
    type: "tabductor:connect",
    serverUrl,
    tabInfo: toTabInfo(activeTab),
  });
  return { ok: true };
}

async function disconnectActiveTab() {
  const activeTab = await getActiveTab();
  if (!activeTab?.id) {
    throw new Error("No active tab");
  }

  await clearConnectedTab(activeTab.id);
  try {
    await chrome.tabs.sendMessage(activeTab.id, {
      type: "tabductor:disconnect",
    });
  } catch (_error) {
    // Ignore missing receiver errors during disconnect.
  }
  return { ok: true };
}

async function disconnectTabById(tabId) {
  await clearConnectedTab(tabId);
  try {
    await ensureContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, {
      type: "tabductor:disconnect",
    });
  } catch (_error) {
    // Ignore missing receiver errors during disconnect.
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  return tab;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "tabductor:ping" });
    await ensurePageConsoleBridge(tabId);
    return;
  } catch (_error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    await ensurePageConsoleBridge(tabId);
    await chrome.tabs.sendMessage(tabId, { type: "tabductor:ping" });
  }
}

async function ensurePageConsoleBridge(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["page-console-bridge.js"],
      world: "MAIN",
    });
  } catch (_error) {
    // Some pages or frames may reject main-world injection; console capture is best-effort.
  }
}

async function ensureConnectableTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url || "";
  if (!/^https?:/i.test(url)) {
    throw new Error("Only http(s) tabs are supported by Tabductor");
  }
}

async function getServerUrl() {
  const result = await chrome.storage.local.get([SERVER_URL_KEY]);
  return result[SERVER_URL_KEY] || DEFAULT_SERVER_URL;
}

async function getConnectedTabs() {
  const result = await chrome.storage.local.get([CONNECTED_TABS_KEY]);
  return result[CONNECTED_TABS_KEY] || {};
}

async function setConnectedTab(tabId, serverUrl) {
  const connectedTabs = await getConnectedTabs();
  connectedTabs[String(tabId)] = serverUrl;
  await chrome.storage.local.set({ [CONNECTED_TABS_KEY]: connectedTabs });
}

async function clearConnectedTab(tabId) {
  const connectedTabs = await getConnectedTabs();
  delete connectedTabs[String(tabId)];
  await chrome.storage.local.set({ [CONNECTED_TABS_KEY]: connectedTabs });
}

function toTabInfo(tab) {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    faviconUrl: tab.favIconUrl,
  };
}

function normalizeRuntimeMessageType(type) {
  if (typeof type !== "string") {
    return type;
  }
  return type;
}

function normalizeError(error) {
  if (error instanceof Error) {
    return {
      code: error.message.includes("Could not establish connection")
        ? "NO_CONNECTED_TAB"
        : "UNKNOWN_ERROR",
      message: error.message,
    };
  }

  return {
    code: "UNKNOWN_ERROR",
    message: String(error),
  };
}

async function executeRunJsInTab(tabId, payload) {
  const target = { tabId };
  let attached = false;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  try {
    await chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION);
    attached = true;
    await chrome.debugger.sendCommand(target, "Runtime.enable");
    const response = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: buildRunJsExpression(payload, startedAt, startedAtMs),
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
    });

    if (response?.exceptionDetails) {
      return buildFailedRunJsResult(
        {
          message:
            response.exceptionDetails.exception?.description ||
            response.exceptionDetails.text ||
            "JavaScript execution failed",
        },
        payload,
        startedAt,
        startedAtMs,
      );
    }

    const value = response?.result?.value;
    if (value && typeof value === "object") {
      return value;
    }

    return buildFailedRunJsResult(
      { message: "JavaScript execution returned no structured result" },
      payload,
      startedAt,
      startedAtMs,
    );
  } catch (error) {
    return buildFailedRunJsResult(normalizeRunJsError(error), payload, startedAt, startedAtMs);
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(target);
      } catch (_error) {
        // Ignore detach failures after execution.
      }
    }
  }
}

function buildFailedRunJsResult(error, payload, startedAt, startedAtMs) {
  return {
    success: false,
    error,
    logs: [],
    runId: typeof payload.runId === "string" ? payload.runId : undefined,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - startedAtMs),
    interactionSummary: {
      clicks: 0,
      types: 0,
      selects: 0,
      keypresses: 0,
      scrolls: 0,
      focuses: 0,
    },
  };
}

function buildRunJsExpression(payload, startedAt, startedAtMs) {
  const helperSources = [
    pageWait,
    pageNormalizeText,
    pageGetAriaLabelledByText,
    pageGetLabelText,
    pageGetDirectText,
    pageGetRole,
    pageGetNodeName,
    pageSummarizeElement,
    pageNormalizeRunJsError,
    pageSerializeForWire,
    pageStringifyConsoleArg,
    pageResolveQueryRoot,
    pageFindElementByRef,
    pageResolveRunJsTarget,
    pageSetFormValue,
    pageDispatchMouseEvent,
    pageDispatchKeyboardEvent,
    pageCreateRunJsConsole,
    pageCreateRunJsHelpers,
    pageWithTimeout,
    pageBuildRunJsResponse,
  ]
    .map((fn) => fn.toString())
    .join("\n\n");

  const serializedPayload = JSON.stringify({
    args: payload.args ?? null,
    runId: typeof payload.runId === "string" ? payload.runId : undefined,
    timeoutMs: typeof payload.timeoutMs === "number" ? payload.timeoutMs : 30000,
  });

  return `
(async function () {
  const payload = ${serializedPayload};
  const startedAt = ${JSON.stringify(startedAt)};
  const startedAtMs = ${startedAtMs};
  ${helperSources}

  const logs = [];
  const interactionSummary = {
    clicks: 0,
    types: 0,
    selects: 0,
    keypresses: 0,
    scrolls: 0,
    focuses: 0,
  };
  const consoleProxy = pageCreateRunJsConsole(logs);
  const tabductor = pageCreateRunJsHelpers(interactionSummary);

  try {
    const rawResult = await pageWithTimeout(
      Promise.resolve(
        (async function (args, tabductor, console, window, document) {
${payload.code}
        })(payload.args, tabductor, consoleProxy, window, document),
      ),
      payload.timeoutMs,
      "tabductor_run_js timed out",
    );

    return pageBuildRunJsResponse({
      success: true,
      result: pageSerializeForWire(rawResult),
      logs,
      runId: payload.runId,
      startedAt,
      startedAtMs,
      finishedAt: new Date().toISOString(),
      interactionSummary,
    });
  } catch (error) {
    return pageBuildRunJsResponse({
      success: false,
      error: pageNormalizeRunJsError(error),
      logs,
      runId: payload.runId,
      startedAt,
      startedAtMs,
      finishedAt: new Date().toISOString(),
      interactionSummary,
    });
  }
})()
`;
}

function normalizeRunJsError(error) {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
  };
}

async function captureTabScreenshot(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const activeTabs = await chrome.tabs.query({
    active: true,
    windowId: tab.windowId,
  });
  const previouslyActiveTab = activeTabs[0];

  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true });
    await wait(100);
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });

  if (previouslyActiveTab?.id && previouslyActiveTab.id !== tabId) {
    await chrome.tabs.update(previouslyActiveTab.id, { active: true });
  }

  return dataUrl.replace(/^data:image\/png;base64,/, "");
}

function pageWait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function pageNormalizeText(value, maxLength = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}...`;
}

function pageGetAriaLabelledByText(element) {
  const ids = pageNormalizeText(element.getAttribute("aria-labelledby")).split(" ");
  if (!ids[0]) {
    return "";
  }
  return pageNormalizeText(
    ids
      .map((id) => document.getElementById(id)?.textContent || "")
      .filter(Boolean)
      .join(" "),
  );
}

function pageGetLabelText(element) {
  if ("labels" in element && element.labels?.length) {
    return Array.from(element.labels)
      .map((label) => label.textContent || "")
      .join(" ");
  }
  return "";
}

function pageGetDirectText(element) {
  return Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent || "")
    .join(" ");
}

function pageGetRole(element) {
  const explicitRole = element.getAttribute("role");
  if (explicitRole) {
    return explicitRole;
  }

  const tag = element.tagName.toLowerCase();
  if (tag === "a" && element.hasAttribute("href")) return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    if (element.type === "search" || element.type === "text") return "textbox";
    return element.type || "input";
  }
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "img") return "img";
  return undefined;
}

function pageGetNodeName(element) {
  const ariaLabel = pageNormalizeText(element.getAttribute("aria-label"));
  if (ariaLabel) {
    return ariaLabel;
  }

  const labelledBy = pageGetAriaLabelledByText(element);
  if (labelledBy) {
    return labelledBy;
  }

  if (element instanceof HTMLInputElement) {
    const labelText = pageNormalizeText(pageGetLabelText(element));
    return (
      labelText ||
      pageNormalizeText(element.placeholder) ||
      pageNormalizeText(element.value)
    );
  }

  if (element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
    return (
      pageNormalizeText(pageGetLabelText(element)) ||
      pageNormalizeText(element.placeholder) ||
      pageNormalizeText(pageGetDirectText(element))
    );
  }

  return pageNormalizeText(pageGetDirectText(element) || element.textContent);
}

function pageSummarizeElement(element) {
  return {
    tagName: element.tagName.toLowerCase(),
    id: element.id || undefined,
    role: pageGetRole(element) || undefined,
    name: pageGetNodeName(element) || undefined,
    text: pageNormalizeText(element.textContent, 160) || undefined,
    ref: element.getAttribute("data-tabductor-ref") || undefined,
  };
}

function pageNormalizeRunJsError(error) {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }
  return {
    message: String(error),
  };
}

function pageSerializeForWire(value, depth = 0, seen = new WeakSet()) {
  if (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "undefined") {
    return null;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }

  if (value instanceof Error) {
    return pageNormalizeRunJsError(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Element) {
    return pageSummarizeElement(value);
  }

  if (value instanceof Node) {
    return {
      nodeType: value.nodeType,
      text: pageNormalizeText(value.textContent, 160),
    };
  }

  if (depth >= 4) {
    return "[MaxDepth]";
  }

  if (Array.isArray(value)) {
    return value.slice(0, 200).map((entry) => pageSerializeForWire(entry, depth + 1, seen));
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const result = {};
    for (const [key, entry] of Object.entries(value).slice(0, 200)) {
      result[key] = pageSerializeForWire(entry, depth + 1, seen);
    }
    return result;
  }

  return String(value);
}

function pageStringifyConsoleArg(value) {
  const serialized = pageSerializeForWire(value);
  if (typeof serialized === "string") {
    return serialized;
  }
  try {
    return JSON.stringify(serialized);
  } catch (_error) {
    return String(serialized);
  }
}

function pageResolveQueryRoot(root) {
  if (!root) {
    return document;
  }
  if (typeof root === "string") {
    const element = document.querySelector(root);
    if (!element) {
      throw new Error(`No root matched selector: ${root}`);
    }
    return element;
  }
  if (root instanceof Element || root instanceof Document) {
    return root;
  }
  throw new Error("Query root must be a selector, Element, or Document");
}

function pageFindElementByRef(ref) {
  const selector = `[data-tabductor-ref="${CSS.escape(String(ref))}"]`;
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`node_not_found: Ref ${ref} is not available on the page`);
  }
  return element;
}

function pageResolveRunJsTarget(target) {
  if (target instanceof Element) {
    return target;
  }
  if (typeof target === "string") {
    const element = document.querySelector(target);
    if (!element) {
      throw new Error(`No element matched selector: ${target}`);
    }
    return element;
  }
  if (target && typeof target === "object" && typeof target.ref === "string") {
    return pageFindElementByRef(target.ref);
  }
  throw new Error("Target must be a selector string, Element, or { ref } object");
}

function pageSetFormValue(element, value) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  descriptor?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function pageDispatchMouseEvent(element, type) {
  element.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
    }),
  );
}

function pageDispatchKeyboardEvent(element, type, key) {
  element.dispatchEvent(
    new KeyboardEvent(type, {
      key,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function pageCreateRunJsConsole(logs) {
  const makeLogger = (level) => (...args) => {
    logs.push({
      level,
      args: args.map(pageStringifyConsoleArg),
      timestamp: new Date().toISOString(),
      source: "run_js",
    });
  };

  return {
    log: makeLogger("log"),
    info: makeLogger("info"),
    warn: makeLogger("warn"),
    error: makeLogger("error"),
  };
}

function pageCreateRunJsHelpers(interactionSummary) {
  return {
    query(selector, root) {
      return pageResolveQueryRoot(root).querySelector(selector);
    },
    queryAll(selector, root) {
      return Array.from(pageResolveQueryRoot(root).querySelectorAll(selector));
    },
    async click(target) {
      const element = pageResolveRunJsTarget(target);
      element.scrollIntoView({ block: "center", inline: "center" });
      pageDispatchMouseEvent(element, "mouseover");
      pageDispatchMouseEvent(element, "mousedown");
      pageDispatchMouseEvent(element, "mouseup");
      element.click();
      interactionSummary.clicks += 1;
      return pageSummarizeElement(element);
    },
    async type(target, text, options = {}) {
      const element = pageResolveRunJsTarget(target);
      element.scrollIntoView({ block: "center", inline: "center" });
      element.focus();

      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
      ) {
        pageSetFormValue(element, String(text));
      } else if (element instanceof HTMLElement && element.isContentEditable) {
        element.textContent = String(text);
        element.dispatchEvent(new InputEvent("input", { bubbles: true }));
      } else {
        throw new Error(`Unsupported element for typing: ${element.tagName}`);
      }

      if (options.submit) {
        pageDispatchKeyboardEvent(element, "keydown", "Enter");
        pageDispatchKeyboardEvent(element, "keyup", "Enter");
        if (element.form) {
          element.form.requestSubmit();
        }
      }

      interactionSummary.types += 1;
      return pageSummarizeElement(element);
    },
    async select(target, values) {
      const element = pageResolveRunJsTarget(target);
      if (!(element instanceof HTMLSelectElement)) {
        throw new Error("Target is not a select element");
      }

      const nextValues = Array.isArray(values) ? values : [values];
      const selectedValues = new Set(nextValues.map((value) => String(value)));
      for (const option of element.options) {
        option.selected = selectedValues.has(option.value);
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      interactionSummary.selects += 1;
      return pageSummarizeElement(element);
    },
    async press(key, target) {
      const element = target
        ? pageResolveRunJsTarget(target)
        : document.activeElement || document.body;
      pageDispatchKeyboardEvent(element, "keydown", String(key));
      pageDispatchKeyboardEvent(element, "keyup", String(key));
      interactionSummary.keypresses += 1;
      return pageSummarizeElement(element);
    },
    async focus(target) {
      const element = pageResolveRunJsTarget(target);
      element.focus();
      interactionSummary.focuses += 1;
      return pageSummarizeElement(element);
    },
    async scrollIntoView(target, options) {
      const element = pageResolveRunJsTarget(target);
      element.scrollIntoView(options || { block: "center", inline: "center" });
      interactionSummary.scrolls += 1;
      return pageSummarizeElement(element);
    },
    wait: pageWait,
    refs() {
      return Array.from(document.querySelectorAll("[data-tabductor-ref]")).map((element) => ({
        ref: element.getAttribute("data-tabductor-ref"),
        element: pageSummarizeElement(element),
      }));
    },
  };
}

async function pageWithTimeout(promise, timeoutMs, message) {
  let timeoutId = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId != null) {
      clearTimeout(timeoutId);
    }
  }
}

function pageBuildRunJsResponse(options) {
  return {
    success: options.success,
    ...(options.success ? { result: options.result } : { error: options.error }),
    logs: options.logs,
    runId: options.runId,
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    durationMs: Math.max(0, Date.now() - options.startedAtMs),
    interactionSummary: options.interactionSummary,
  };
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

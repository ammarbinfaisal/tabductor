const DEFAULT_SERVER_URL = "ws://127.0.0.1:8765";
const CONNECTED_TABS_KEY = "browsermcpConnectedTabs";
const SERVER_URL_KEY = "browsermcpServerUrl";

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get([SERVER_URL_KEY, CONNECTED_TABS_KEY]);
  const next = {};
  if (!current[SERVER_URL_KEY]) {
    next[SERVER_URL_KEY] = DEFAULT_SERVER_URL;
  }
  if (!current[CONNECTED_TABS_KEY]) {
    next[CONNECTED_TABS_KEY] = {};
  }
  if (Object.keys(next).length > 0) {
    await chrome.storage.local.set(next);
  }
});

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
      type: "browsermcp:connect",
      serverUrl,
      tabInfo: toTabInfo((await chrome.tabs.get(tabId)) || { id: tabId }),
    });
  } catch (error) {
    console.error("Failed to reconnect Browser MCP tab", error);
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
  switch (message?.type) {
    case "browsermcp:popup-status":
      return getPopupStatus();
    case "browsermcp:popup-connect-active-tab":
      return connectActiveTab();
    case "browsermcp:popup-disconnect-active-tab":
      return disconnectActiveTab();
    case "browsermcp:popup-disconnect-tab":
      await disconnectTabById(message.tabId);
      return { ok: true };
    case "browsermcp:popup-set-server-url":
      await chrome.storage.local.set({ [SERVER_URL_KEY]: message.serverUrl });
      return { ok: true };
    case "browsermcp:capture-screenshot":
      if (sender.tab?.id == null) {
        throw new Error("No sender tab for screenshot");
      }
      return {
        ok: true,
        data: await captureTabScreenshot(sender.tab.id),
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
        type: "browsermcp:status",
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
          type: "browsermcp:status",
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
    type: "browsermcp:connect",
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
      type: "browsermcp:disconnect",
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
      type: "browsermcp:disconnect",
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
    await chrome.tabs.sendMessage(tabId, { type: "browsermcp:ping" });
    await ensurePageConsoleBridge(tabId);
    return;
  } catch (_error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    await ensurePageConsoleBridge(tabId);
    await chrome.tabs.sendMessage(tabId, { type: "browsermcp:ping" });
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
  const result = await chrome.storage.local.get(SERVER_URL_KEY);
  return result[SERVER_URL_KEY] || DEFAULT_SERVER_URL;
}

async function getConnectedTabs() {
  const result = await chrome.storage.local.get(CONNECTED_TABS_KEY);
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

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

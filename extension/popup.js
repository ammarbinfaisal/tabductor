const serverUrlInput = document.getElementById("server-url");
const statusEl = document.getElementById("status");
const connectedTabsEl = document.getElementById("connected-tabs");
const refreshButton = document.getElementById("refresh");

document.getElementById("save-url").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "browsermcp:popup-set-server-url",
    serverUrl: serverUrlInput.value.trim(),
  });
  await refresh();
});

document.getElementById("connect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "browsermcp:popup-connect-active-tab" });
  await refresh();
});

document.getElementById("disconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "browsermcp:popup-disconnect-active-tab",
  });
  await refresh();
});

refreshButton.addEventListener("click", async () => {
  await refresh();
});

async function refresh() {
  const status = await chrome.runtime.sendMessage({
    type: "browsermcp:popup-status",
  });

  serverUrlInput.value = status.serverUrl || "";
  statusEl.textContent = [
    `Active Tab Connected: ${status.connected}`,
    `Active Tab Desired: ${status.desiredConnected}`,
    `Connected Tabs: ${status.connectedCount ?? status.connectedTabs?.length ?? 0}`,
    `Active Tab: ${status.activeTab?.title || "None"}`,
    `URL: ${status.activeTab?.url || "None"}`,
    `Snapshot Version: ${status.tabStatus?.snapshotVersion ?? "?"}`,
    `Socket Status: ${status.tabStatus?.status ?? "unknown"}`,
    `Last Error: ${status.tabStatus?.lastConnectionError ?? "none"}`,
  ].join("\n");

  connectedTabsEl.innerHTML = '<div class="section-title">Connected Tabs</div>';
  if (!status.connectedTabs?.length) {
    const empty = document.createElement("div");
    empty.textContent = "No connected tabs";
    empty.className = "tab-meta";
    connectedTabsEl.appendChild(empty);
    return;
  }

  const tabs = [...status.connectedTabs].sort((left, right) => {
    if (left.active !== right.active) {
      return left.active ? -1 : 1;
    }
    return (left.title || "").localeCompare(right.title || "");
  });

  for (const tab of tabs) {
    const card = document.createElement("div");
    card.className = "tab-card";
    const title = document.createElement("div");
    title.className = "tab-title";
    title.textContent = `${tab.title || "Untitled"}${tab.active ? " (active)" : ""}`;
    const url = document.createElement("div");
    url.className = "tab-url";
    url.textContent = tab.url || "";
    const meta = document.createElement("div");
    meta.className = "tab-meta";
    meta.textContent = [
      `Tab ${tab.id}`,
      tab.status?.status || "unknown",
      `v${tab.status?.snapshotVersion ?? "?"}`,
      tab.status?.desiredConnection ? "desired" : "manual-off",
    ].join(" | ");
    const disconnect = document.createElement("button");
    disconnect.textContent = "Disconnect";
    disconnect.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({
        type: "browsermcp:popup-disconnect-tab",
        tabId: tab.id,
      });
      await refresh();
    });

    card.append(title, url, meta, disconnect);
    connectedTabsEl.appendChild(card);
  }
}

refresh().catch((error) => {
  statusEl.textContent = String(error);
});

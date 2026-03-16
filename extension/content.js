(function () {
  if (globalThis.__browserMcpControllerInstalled) {
    return;
  }
  globalThis.__browserMcpControllerInstalled = true;

  const state = {
    nextNodeId: 1,
    nextRefId: 1,
    nodeIds: new WeakMap(),
    elementRefs: new WeakMap(),
    refs: new Map(),
    refVersions: new Map(),        // ref → snapshotVersion when ref was first assigned
    lastSnapshotNodes: new Map(),  // nodeId → fingerprint string from last snapshot build
    snapshotVersion: 1,
    lastInvalidation: null,
    snapshotTimer: null,
    maxContextNodes: 10,
    ws: null,
    wsStatus: "disconnected",
    serverUrl: null,
    desiredConnection: false,
    reconnectTimer: null,
    reconnectDelayMs: 1000,
    lastConnectionError: null,
    consoleLogs: [],
    tabInfo: null,
    deactivated: false,
    mutationObserver: null,
    domReadyListener: null,
  };

  installConsoleBridge();
  installMutationObserver();
  installNavigationListeners();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isControllerActive()) {
      sendResponse({ ok: false, error: "Extension context unavailable" });
      return false;
    }
    handleMessage(message)
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  });

  async function handleMessage(message) {
    switch (message?.type) {
      case "browsermcp:ping":
        return { ok: true };
      case "browsermcp:status":
        return {
          connected: state.wsStatus === "open",
          desiredConnection: state.desiredConnection,
          status: state.wsStatus,
          serverUrl: state.serverUrl,
          lastConnectionError: state.lastConnectionError,
          page: getPageState(),
          snapshotVersion: state.snapshotVersion,
          tabInfo: state.tabInfo,
        };
      case "browsermcp:connect":
        return connectSocket(message.serverUrl, message.tabInfo || null);
      case "browsermcp:disconnect":
        disconnectSocket();
        return { ok: true };
      default:
        throw new Error(`Unknown content-script message: ${message?.type}`);
    }
  }

  async function connectSocket(serverUrl, tabInfo) {
    if (!serverUrl) {
      throw new Error("Missing serverUrl");
    }
    ensureControllerActive();

    state.tabInfo = tabInfo || state.tabInfo;
    state.desiredConnection = true;
    state.serverUrl = serverUrl;
    state.lastConnectionError = null;
    clearReconnectTimer();

    if (
      state.ws &&
      state.ws.readyState === WebSocket.OPEN &&
      state.serverUrl === serverUrl
    ) {
      sendSocketNotification("browser.session.hello", buildHello());
      scheduleSnapshotUpdate("navigation", "full", "Connection reused");
      return { ok: true, reused: true };
    }

    openSocket(serverUrl);

    return { ok: true };
  }

  function disconnectSocket() {
    state.desiredConnection = false;
    state.lastConnectionError = null;
    clearReconnectTimer();
    closeSocket();
  }

  function openSocket(serverUrl) {
    closeSocket();
    state.wsStatus = "connecting";

    const ws = new WebSocket(serverUrl);
    state.ws = ws;

    ws.addEventListener("open", () => {
      if (state.ws !== ws) {
        ws.close();
        return;
      }
      state.wsStatus = "open";
      state.lastConnectionError = null;
      state.reconnectDelayMs = 1000;
      clearReconnectTimer();
      sendSocketNotification("browser.session.hello", buildHello());
      scheduleSnapshotUpdate("navigation", "full", "Socket connected");
    });

    ws.addEventListener("message", async (event) => {
      try {
        await handleServerMessage(event.data);
      } catch (error) {
        console.error("Browser MCP content message error", error);
      }
    });

    ws.addEventListener("close", () => {
      if (state.ws === ws) {
        state.ws = null;
        state.wsStatus = "disconnected";
        scheduleReconnect();
      }
    });

    ws.addEventListener("error", (error) => {
      state.lastConnectionError =
        error instanceof Event ? "WebSocket error" : String(error);
      console.error("Browser MCP content websocket error", error);
    });
  }

  function closeSocket() {
    if (state.ws) {
      try {
        state.ws.close();
      } catch (_error) {
        // Ignore close errors.
      }
    }
    state.ws = null;
    state.wsStatus = "disconnected";
  }

  function scheduleReconnect() {
    if (!state.desiredConnection || !state.serverUrl || !isControllerActive()) {
      return;
    }
    if (state.reconnectTimer != null) {
      return;
    }

    const delay = state.reconnectDelayMs;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (!state.desiredConnection || !state.serverUrl || !isControllerActive()) {
        return;
      }
      openSocket(state.serverUrl);
      state.reconnectDelayMs = Math.min(state.reconnectDelayMs * 2, 10000);
    }, delay);
  }

  function clearReconnectTimer() {
    if (state.reconnectTimer != null) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  }

  function sendSocketMessage(message) {
    if (!isControllerActive()) {
      return;
    }
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      state.ws.send(JSON.stringify(message));
    } catch (_error) {
      disconnectSocket();
    }
  }

  function sendSocketNotification(event, payload) {
    sendSocketMessage({ event, payload });
  }

  function sendSocketSuccess(id, result) {
    sendSocketMessage({ id, ok: true, result });
  }

  function sendSocketError(id, error) {
    const code =
      error instanceof Error && error.code ? error.code : "UNKNOWN_ERROR";
    sendSocketMessage({
      id,
      ok: false,
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }

  function checkExpectedVersion(payload) {
    if (payload.expectedVersion == null) {
      return;
    }
    if (state.snapshotVersion > payload.expectedVersion) {
      const err = new Error(
        `STALE_REF: Page is at version ${state.snapshotVersion}, action expected version <= ${payload.expectedVersion}. Re-fetch actionables.`,
      );
      err.code = "STALE_REF";
      throw err;
    }
  }

  async function handleServerMessage(raw) {
    ensureControllerActive();
    const message = JSON.parse(typeof raw === "string" ? raw : String(raw));
    if (!message?.id || !message?.type) {
      return;
    }

    try {
      const result = await handleServerRequest(message.type, message.payload || {});
      sendSocketSuccess(message.id, result);
    } catch (error) {
      sendSocketError(message.id, error);
    }
  }

  async function handleServerRequest(type, payload) {
    ensureControllerActive();
    switch (type) {
      case "getUrl":
        return location.href;
      case "getTitle":
        return document.title;
      case "browser_snapshot":
        return buildSnapshot(payload);
      case "browser_navigate":
        location.href = payload.url;
        return { acknowledged: true };
      case "browser_go_back":
        history.back();
        return { acknowledged: true };
      case "browser_go_forward":
        history.forward();
        return { acknowledged: true };
      case "browser_click":
        return performClick(payload);
      case "browser_hover":
        return performHover(payload);
      case "browser_type":
        return performType(payload);
      case "browser_select_option":
        return performSelectOption(payload);
      case "browser_press_key":
        return performPressKey(payload);
      case "browser_wait":
        await wait(Math.max(0, payload.time * 1000));
        return { acknowledged: true };
      case "browser_get_console_logs":
        return state.consoleLogs.slice(-200);
      case "browser_screenshot": {
        const response = await chrome.runtime.sendMessage({
          type: "browsermcp:capture-screenshot",
        });
        if (!response?.ok) {
          throw new Error(response?.error?.message || "Failed to capture screenshot");
        }
        return response.data;
      }
      case "browser_describe_ref":
        return describeRef(payload.ref);
      default:
        throw new Error(`Unsupported request type: ${type}`);
    }
  }

  function buildHello() {
    return {
      page: getPageState(),
      extensionVersion: getExtensionVersion(),
      browserName: "chrome",
      userAgent: navigator.userAgent,
      capabilities: {
        structuredSnapshots: true,
        versionedSnapshots: true,
        invalidationEvents: true,
        partialInvalidation: true,
      },
      snapshotVersion: state.snapshotVersion,
    };
  }

  function getPageState() {
    return {
      url: location.href,
      title: document.title,
      tabId: state.tabInfo?.tabId,
      windowId: state.tabInfo?.windowId,
      faviconUrl: state.tabInfo?.faviconUrl,
    };
  }

  function fingerprintSnapshotNode(node) {
    return JSON.stringify({
      ref: node.ref,
      role: node.role,
      name: node.name,
      value: node.value,
      description: node.description,
      properties: node.properties,
    });
  }

  function recordSnapshotNodes(nodes) {
    state.lastSnapshotNodes.clear();
    const visit = (node) => {
      state.lastSnapshotNodes.set(node.nodeId, fingerprintSnapshotNode(node));
      for (const child of node.children ?? []) {
        visit(child);
      }
    };
    for (const node of nodes) {
      visit(node);
    }
  }

  function buildSnapshot() {
    const root = captureSnapshotTree();
    recordSnapshotNodes(root);
    return {
      page: getPageState(),
      snapshot: {
        version: state.snapshotVersion,
        generatedAt: new Date().toISOString(),
        format: "semantic-tree-v1",
        mode: "full",
        root,
        invalidation: state.lastInvalidation,
      },
    };
  }

  function pruneStaleRefs() {
    for (const [ref, element] of state.refs) {
      if (!document.contains(element)) {
        state.refs.delete(ref);
        state.refVersions.delete(ref);
      }
    }
  }

  function captureSnapshotTree() {
    pruneStaleRefs();
    if (!document.body) {
      return [];
    }

    const actionables = selectActionableElements(
      rankElements(collectActionableElements(), scoreActionableElement),
    );

    if (actionables.length > 0) {
      return buildSemanticActionTree(actionables);
    }

    return buildContextTree(
      rankElements(collectContextElements(), scoreContextElement).slice(
        0,
        state.maxContextNodes,
      ),
    );
  }

  function collectActionableElements() {
    const elements = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const element = walker.currentNode;
      if (!(element instanceof Element)) {
        continue;
      }
      if (!isVisible(element) || !isActionableElement(element)) {
        continue;
      }
      elements.push(element);
    }
    return uniqueElements(elements);
  }

  function collectContextElements() {
    const elements = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const element = walker.currentNode;
      if (!(element instanceof Element)) {
        continue;
      }
      if (!isVisible(element) || !isContextElement(element)) {
        continue;
      }
      elements.push(element);
    }
    return uniqueElements(elements);
  }

  function uniqueElements(elements) {
    return Array.from(new Set(elements));
  }

  function rankElements(elements, scoreElement) {
    return elements
      .map((element, index) => ({
        element,
        index,
        score: scoreElement(element),
      }))
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return left.index - right.index;
      })
      .map((entry) => entry.element);
  }

  function selectActionableElements(elements) {
    const selected = [];
    const seenSignatures = new Set();
    const groupTotals = new Map();
    const groupLinkTotals = new Map();

    for (const element of elements) {
      const role = getRole(element);
      if (shouldSkipActionableElement(element, role)) {
        continue;
      }

      const context = getContextHints(element);
      const groupKey = getSemanticGroupKey(context);
      const signature = getActionableSignature(element, role, groupKey);
      const currentGroupTotal = groupTotals.get(groupKey) || 0;
      const currentGroupLinkTotal = groupLinkTotals.get(groupKey) || 0;

      if (signature && seenSignatures.has(signature)) {
        continue;
      }
      if (signature) {
        seenSignatures.add(signature);
      }
      groupTotals.set(groupKey, currentGroupTotal + 1);
      if (role === "link") {
        groupLinkTotals.set(groupKey, currentGroupLinkTotal + 1);
      }
      selected.push(element);
    }

    return selected;
  }

  function shouldSkipActionableElement(element, role) {
    if (element instanceof HTMLInputElement && element.type === "hidden") {
      return true;
    }

    if ((role === "link" || role === "button") && !getNodeName(element)) {
      return true;
    }

    return false;
  }

  function getActionableSignature(element, role, groupKey) {
    const name = normalizeText(getNodeName(element), 48);
    const value = normalizeText(getElementValue(element), 32);
    const inputType =
      element instanceof HTMLInputElement ? element.type || "text" : "";

    if (!name && !value && !inputType) {
      return "";
    }

    return [groupKey, role || "", inputType, name, value].join("|");
  }

  function buildSemanticActionTree(actionables) {
    const groups = [];
    const groupsByKey = new Map();

    for (const element of actionables) {
      const descriptor = getGroupDescriptor(element);
      let group = groupsByKey.get(descriptor.key);
      if (!group) {
        group = createGroupNode(descriptor, groups.length + 1);
        groupsByKey.set(descriptor.key, group);
        groups.push(group);
      }

      const child = captureElement(
        element,
        "action",
        group.children.length + 1,
        descriptor.context,
      );
      if (child) {
        group.children.push(child);
      }
    }

    for (const group of groups) {
      if (!group.children.length) {
        continue;
      }

      group.properties.itemCount = group.children.length;
      if (group.children.length === 1 && !group.name) {
        group.name = group.children[0].name || group.children[0].role || "group";
      }
    }

    return groups.filter((group) => group.children.length > 0);
  }

  function buildContextTree(elements) {
    return elements
      .map((element, index) => captureElement(element, "context", index + 1))
      .filter(Boolean);
  }

  function getGroupDescriptor(element) {
    const context = getContextHints(element);
    const container =
      getSemanticContainer(element) ||
      element.closest("section,article,[role='region'],[role='tablist']");
    const groupKey = container ? getNodeId(container) : `g:${getSemanticGroupKey(context)}`;
    const label =
      context.form ||
      context.heading ||
      context.landmark ||
      context.section ||
      "Page";
    const role = container ? getRole(container) || "group" : "group";

    return {
      key: groupKey,
      element: container,
      role,
      label,
      context,
    };
  }

  function getSemanticContainer(element) {
    return element.closest(
      "dialog,form,main,nav,aside,header,footer,[role='dialog'],[role='main'],[role='search'],[role='navigation'],[role='form'],[role='region'],[role='tablist']",
    );
  }

  function getSemanticGroupKey(context) {
    return [
      context.landmark || "",
      context.heading || "",
      context.form || "",
      context.section || "",
    ].join("|");
  }

  function createGroupNode(descriptor, ordinal) {
    const properties = {
      kind: "group",
      ordinal,
      landmark: descriptor.context.landmark || undefined,
      heading: descriptor.context.heading || undefined,
      form: descriptor.context.form || undefined,
      section: descriptor.context.section || undefined,
      inViewport: descriptor.element ? isInViewport(descriptor.element) : undefined,
      itemCount: 0,
    };

    Object.keys(properties).forEach((key) => {
      if (properties[key] == null || properties[key] === false) {
        delete properties[key];
      }
    });

    return {
      nodeId: descriptor.element
        ? getNodeId(descriptor.element)
        : toSyntheticNodeId(descriptor.key),
      role: descriptor.role,
      name: descriptor.label,
      properties,
      children: [],
    };
  }

  function toSyntheticNodeId(key) {
    return `g:${String(key || "page").replace(/[^a-zA-Z0-9:_-]+/g, "_")}`;
  }

  function captureElement(element, kind, ordinal, contextOverride) {
    const nodeId = getNodeId(element);
    const role = getRole(element);
    const name = getNodeName(element);
    const value = getElementValue(element);
    const description = getDescription(element);
    const isActionable = kind === "action" && isActionableElement(element);
    const ref = isActionable ? getRef(element) : undefined;
    const context = contextOverride || getContextHints(element);
    const properties = getCompactProperties(element, kind, ordinal, context);

    const node = {
      nodeId,
      ref,
      role,
      name,
      value,
      description,
      properties,
    };

    if (!node.name) {
      delete node.name;
    }
    if (!node.value) {
      delete node.value;
    }
    if (!node.description) {
      delete node.description;
    }
    if (!node.properties || Object.keys(node.properties).length === 0) {
      delete node.properties;
    }

    return node;
  }

  function isContextElement(element) {
    if (isActionableElement(element)) {
      return false;
    }
    if (isHeadingElement(element)) {
      return true;
    }
    if (isLandmarkElement(element)) {
      return true;
    }
    if (element.matches("label, legend")) {
      return normalizeText(element.textContent).length > 0;
    }
    if (
      element.getAttribute("role") === "status" ||
      element.getAttribute("role") === "alert" ||
      element.hasAttribute("aria-live")
    ) {
      return normalizeText(element.textContent).length > 0;
    }
    return false;
  }

  function isLandmarkElement(element) {
    const tag = element.tagName.toLowerCase();
    if (/^(main|nav|aside|header|footer|form|dialog)$/.test(tag)) {
      return true;
    }

    const role = element.getAttribute("role");
    return Boolean(
      role &&
        /^(main|navigation|search|banner|contentinfo|complementary|form|dialog|region|tablist)$/.test(
          role,
        ),
    );
  }

  function isHeadingElement(element) {
    const tag = element.tagName.toLowerCase();
    if (/^h[1-4]$/.test(tag)) {
      return true;
    }
    return element.getAttribute("role") === "heading";
  }

  function isActionableElement(element) {
    if (element.matches("a[href], button, input, select, textarea, summary")) {
      return true;
    }

    const role = element.getAttribute("role");
    return Boolean(
      role &&
        /^(button|link|checkbox|radio|tab|menuitem|option|textbox|combobox|switch)$/.test(
          role,
        ),
    );
  }

  function isVisible(element) {
    if (element.getAttribute("aria-hidden") === "true" || element.hasAttribute("hidden")) {
      return false;
    }

    const style = getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    ) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isInViewport(element) {
    const rect = element.getBoundingClientRect();
    return (
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth
    );
  }

  function scoreActionableElement(element) {
    let score = isInViewport(element) ? 100 : 0;
    const role = getRole(element);
    const name = getNodeName(element);
    const context = getContextHints(element);

    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      score += 90;
    } else if (role === "button") {
      score += 75;
    } else if (role === "combobox" || role === "textbox") {
      score += 70;
    } else if (role === "link") {
      score += 35;
    } else {
      score += 25;
    }

    if (document.activeElement === element) {
      score += 40;
    }
    if (context.form || context.landmark === "search" || context.landmark === "dialog") {
      score += 25;
    }
    if (name.length > 0 && name.length <= 48) {
      score += 20;
    }
    if (name.length > 90) {
      score -= 20;
    }
    if (element instanceof HTMLInputElement && element.type === "hidden") {
      score -= 200;
    }
    if (Boolean(element.disabled)) {
      score -= 30;
    }
    return score;
  }

  function scoreContextElement(element) {
    let score = isInViewport(element) ? 100 : 0;
    if (isHeadingElement(element)) {
      score += 60;
    }
    if (isLandmarkElement(element)) {
      score += 45;
    }
    if (element.matches("label, legend")) {
      score += 35;
    }
    if (
      element.getAttribute("role") === "status" ||
      element.getAttribute("role") === "alert" ||
      element.hasAttribute("aria-live")
    ) {
      score += 25;
    }
    return score;
  }

  function getNodeId(element) {
    let nodeId = state.nodeIds.get(element);
    if (!nodeId) {
      nodeId = `n${state.nextNodeId++}`;
      state.nodeIds.set(element, nodeId);
    }
    return nodeId;
  }

  function getRef(element) {
    let ref = state.elementRefs.get(element);
    if (!ref) {
      ref = `r${state.nextRefId++}:${getNodeId(element)}`;
      state.elementRefs.set(element, ref);
      state.refVersions.set(ref, state.snapshotVersion);
    }
    state.refs.set(ref, element);
    return ref;
  }

  function findElementByRef(ref) {
    const element = state.refs.get(ref);
    if (element && document.contains(element)) {
      return element;
    }
    throw new Error(`node_not_found: Ref ${ref} is not available on the page`);
  }

  function getRole(element) {
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
    if (isLandmarkElement(element)) return tag;
    return undefined;
  }

  function getNodeName(element) {
    const ariaLabel = normalizeText(element.getAttribute("aria-label"));
    if (ariaLabel) {
      return ariaLabel;
    }

    const labelledBy = getAriaLabelledByText(element);
    if (labelledBy) {
      return labelledBy;
    }

    if (element instanceof HTMLInputElement) {
      const labelText = normalizeText(getLabelText(element));
      return labelText || normalizeText(element.placeholder) || normalizeText(element.value);
    }

    if (element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
      return (
        normalizeText(getLabelText(element)) ||
        normalizeText(element.placeholder) ||
        normalizeText(getDirectText(element))
      );
    }

    if (isHeadingElement(element) || isActionableElement(element) || element.matches("label, legend")) {
      return normalizeText(getDirectText(element) || element.textContent);
    }

    if (isLandmarkElement(element)) {
      return normalizeText(getElementContextLabel(element));
    }

    return normalizeText(getDirectText(element));
  }

  function getAriaLabelledByText(element) {
    const ids = normalizeText(element.getAttribute("aria-labelledby")).split(" ");
    if (!ids[0]) {
      return "";
    }
    return normalizeText(
      ids
        .map((id) => document.getElementById(id)?.textContent || "")
        .filter(Boolean)
        .join(" "),
    );
  }

  function getDescription(element) {
    return normalizeText(
      element.getAttribute("aria-description") ||
        element.getAttribute("title") ||
        "",
    );
  }

  function getElementValue(element) {
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      return normalizeText(element.value);
    }
    return undefined;
  }

  function getLabelText(element) {
    if ("labels" in element && element.labels?.length) {
      return Array.from(element.labels)
        .map((label) => label.textContent || "")
        .join(" ");
    }
    return "";
  }

  function getDirectText(element) {
    return Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent || "")
      .join(" ");
  }

  function normalizeText(value, maxLength = 90) {
    return (value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
  }

  function getContextHints(element) {
    const landmark = element.closest(
      "dialog,main,form,nav,aside,header,footer,[role='dialog'],[role='main'],[role='search'],[role='navigation'],[role='form'],[role='region'],[role='tablist']",
    );
    const form = element.closest("form");
    const section = element.closest("section,article,[role='region']");

    return {
      landmark: normalizeText(getElementContextLabel(landmark), 60),
      heading: normalizeText(findNearestHeadingText(element), 60),
      form: normalizeText(getElementContextLabel(form), 60),
      section: normalizeText(getElementContextLabel(section), 60),
    };
  }

  function getElementContextLabel(element) {
    if (!(element instanceof Element)) {
      return "";
    }

    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) {
      return ariaLabel;
    }

    const labelledBy = getAriaLabelledByText(element);
    if (labelledBy) {
      return labelledBy;
    }

    const headingText = findNearestHeadingText(element);
    if (headingText) {
      return headingText;
    }

    const text = normalizeText(getDirectText(element) || element.textContent, 60);
    if (text) {
      return text;
    }

    const role = element.getAttribute("role");
    if (role) {
      return role;
    }

    return element.tagName.toLowerCase();
  }

  function getCompactProperties(element, kind, ordinal, context) {
    const properties = {
      kind,
      ordinal,
      actions: inferActions(element),
    };

    if (context.landmark) {
      properties.landmark = context.landmark;
    }
    if (context.heading) {
      properties.heading = context.heading;
    }
    if (context.form) {
      properties.form = context.form;
    }
    if (context.section) {
      properties.section = context.section;
    }
    if (isInViewport(element)) {
      properties.inViewport = true;
    }

    if (element instanceof HTMLInputElement) {
      properties.inputType = element.type || "text";
      if (element.checked) properties.checked = true;
      if (element.disabled) properties.disabled = true;
      if (element.required) properties.required = true;
    }
    if (element instanceof HTMLButtonElement && element.disabled) {
      properties.disabled = true;
    }
    if (element instanceof HTMLSelectElement) {
      if (element.disabled) properties.disabled = true;
      if (element.required) properties.required = true;
    }
    if (element instanceof HTMLTextAreaElement) {
      if (element.disabled) properties.disabled = true;
      if (element.required) properties.required = true;
    }
    if (element.getAttribute("aria-expanded") != null) {
      properties.expanded = element.getAttribute("aria-expanded");
    }

    // Include href for links so LLMs know where they point
    if (element instanceof HTMLAnchorElement && element.href) {
      properties.href = element.href;
    }

    // Include placeholder for inputs/textareas
    const placeholder = element.getAttribute("placeholder");
    if (placeholder) {
      properties.placeholder = placeholder;
    }

    if (properties.actions.length === 0) {
      delete properties.actions;
    }

    return properties;
  }

  function collectNearbyRefs(element) {
    const scope =
      element.closest("form, dialog, section, article, main, nav, aside, div") ||
      element.parentElement;
    if (!scope) {
      return [];
    }

    const nearby = [];
    const actionable = scope.querySelectorAll(
      "a[href], button, input, select, textarea, summary, [role]",
    );
    for (const candidate of actionable) {
      if (!(candidate instanceof Element) || candidate === element) {
        continue;
      }
      if (!isVisible(candidate) || !isActionableElement(candidate)) {
        continue;
      }
      nearby.push({
        ref: getRef(candidate),
        role: getRole(candidate),
        name: getNodeName(candidate),
      });
      if (nearby.length >= 8) {
        break;
      }
    }
    return nearby;
  }

  function findNearestHeadingText(element) {
    let current = element;
    while (current) {
      if (current.previousElementSibling) {
        const heading = current.previousElementSibling.matches("h1,h2,h3,h4,[role='heading']")
          ? current.previousElementSibling
          : current.previousElementSibling.querySelector("h1,h2,h3,h4,[role='heading']");
        if (heading) {
          return heading.textContent || "";
        }
      }
      current = current.parentElement;
    }

    const container = element.closest("section, article, main, form, dialog");
    const heading = container?.querySelector("h1,h2,h3,h4,[role='heading']");
    return heading ? heading.textContent || "" : "";
  }

  function describeRef(ref) {
    const element = findElementByRef(ref);
    const context = getContextHints(element);
    return {
      ref,
      nodeId: getNodeId(element),
      role: getRole(element),
      name: getNodeName(element),
      value: getElementValue(element),
      description: getDescription(element),
      page: getPageState(),
      htmlTag: element.tagName.toLowerCase(),
      text: normalizeText(element.textContent, 240),
      attributes: collectAttributes(element),
      states: collectStates(element),
      context: {
        landmark: context.landmark,
        heading: context.heading,
        form: context.form || context.section,
      },
      actions: inferActions(element),
      nearbyRefs: collectNearbyRefs(element),
    };
  }

  function collectAttributes(element) {
    const attributes = {};
    for (const { name, value } of Array.from(element.attributes)) {
      if (/^(aria-|href|type|name|placeholder|title|value)$/i.test(name)) {
        attributes[name] = value;
      }
    }
    return attributes;
  }

  function collectStates(element) {
    return {
      disabled: Boolean(element.disabled),
      expanded: element.getAttribute("aria-expanded") || false,
      checked:
        element instanceof HTMLInputElement ? Boolean(element.checked) : false,
      selected:
        element instanceof HTMLOptionElement ? Boolean(element.selected) : false,
    };
  }

  function inferActions(element) {
    const actions = [];
    if (element.matches("a[href], button, summary, [role='button'], [role='link']")) {
      actions.push("click");
    }
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element.isContentEditable
    ) {
      actions.push("type");
    }
    if (element instanceof HTMLSelectElement) {
      actions.push("select_option");
    }
    return actions;
  }

  async function performClick(payload) {
    checkExpectedVersion(payload);
    const element = findElementByRef(payload.ref);
    element.scrollIntoView({ block: "center", inline: "center" });
    dispatchMouseEvent(element, "mouseover");
    dispatchMouseEvent(element, "mousedown");
    dispatchMouseEvent(element, "mouseup");
    element.click();
    scheduleSnapshotUpdate("input", "subtree", `Clicked ${payload.element}`);
    return { acknowledged: true };
  }

  async function performHover(payload) {
    checkExpectedVersion(payload);
    const element = findElementByRef(payload.ref);
    element.scrollIntoView({ block: "center", inline: "center" });
    dispatchMouseEvent(element, "mouseover");
    dispatchMouseEvent(element, "mouseenter");
    dispatchMouseEvent(element, "mousemove");
    schedulePageUpdate("mutation", "subtree", `Hovered ${payload.element}`);
    return { acknowledged: true };
  }

  async function performType(payload) {
    checkExpectedVersion(payload);
    const element = findElementByRef(payload.ref);
    element.scrollIntoView({ block: "center", inline: "center" });
    element.focus();

    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      setFormValue(element, payload.text);
    } else if (element instanceof HTMLElement && element.isContentEditable) {
      element.textContent = payload.text;
      element.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } else {
      throw new Error(`Unsupported element for typing: ${element.tagName}`);
    }

    if (payload.submit) {
      dispatchKeyboardEvent(element, "keydown", "Enter");
      dispatchKeyboardEvent(element, "keyup", "Enter");
      if (element.form) {
        element.form.requestSubmit();
      }
    }

    scheduleSnapshotUpdate("input", "subtree", `Typed into ${payload.element}`);
    return { acknowledged: true };
  }

  async function performSelectOption(payload) {
    checkExpectedVersion(payload);
    const element = findElementByRef(payload.ref);
    if (!(element instanceof HTMLSelectElement)) {
      throw new Error("Target ref is not a select element");
    }

    const values = new Set(payload.values);
    for (const option of element.options) {
      option.selected = values.has(option.value);
    }

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    scheduleSnapshotUpdate("input", "subtree", `Selected option in ${payload.element}`);
    return { acknowledged: true };
  }

  async function performPressKey(payload) {
    const element = document.activeElement || document.body;
    dispatchKeyboardEvent(element, "keydown", payload.key);
    dispatchKeyboardEvent(element, "keyup", payload.key);
    schedulePageUpdate("input", "subtree", `Pressed key ${payload.key}`);
    return { acknowledged: true };
  }

  function setFormValue(element, value) {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function dispatchMouseEvent(element, type) {
    element.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
      }),
    );
  }

  function dispatchKeyboardEvent(element, type, key) {
    element.dispatchEvent(
      new KeyboardEvent(type, {
        key,
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  function installMutationObserver() {
    const observer = new MutationObserver((mutations) => {
      if (!isControllerActive()) {
        deactivateController();
        return;
      }
      const changedCount = mutations.length;
      scheduleSnapshotUpdate(
        "mutation",
        "full",
        `${changedCount} DOM mutation${changedCount === 1 ? "" : "s"}`,
      );
    });

    const observe = () => {
      if (!isControllerActive()) {
        deactivateController();
        return;
      }
      if (!document.body) {
        return;
      }
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    };

    state.mutationObserver = observer;

    if (document.body) {
      observe();
    } else {
      state.domReadyListener = observe;
      window.addEventListener("DOMContentLoaded", observe, { once: true });
    }
  }

  function installNavigationListeners() {
    window.addEventListener("popstate", () => {
      scheduleSnapshotUpdate("history", "full", "History navigation");
    });

    window.addEventListener("hashchange", () => {
      scheduleSnapshotUpdate("navigation", "subtree", "Hash change");
    });

    window.addEventListener("load", () => {
      scheduleSnapshotUpdate("navigation", "full", "Window load");
    });
  }

  function schedulePageUpdate(reason, scope, summary) {
    if (!isControllerActive()) {
      deactivateController();
      return;
    }
    state.snapshotVersion += 1;
    state.lastInvalidation = {
      version: state.snapshotVersion,
      timestamp: new Date().toISOString(),
      reason,
      scope,
      summary,
    };

    sendSocketNotification("browser.page.updated", {
      page: getPageState(),
      snapshotVersion: state.snapshotVersion,
      invalidation: state.lastInvalidation,
    });
  }

  function scheduleSnapshotUpdate(reason, scope, summary) {
    if (!isControllerActive()) {
      deactivateController();
      return;
    }
    schedulePageUpdate(reason, scope, summary);
    clearTimeout(state.snapshotTimer);
    state.snapshotTimer = setTimeout(() => {
      sendSocketNotification("browser.snapshot.updated", buildSnapshot());
    }, 120);
  }

  function installConsoleBridge() {
    window.addEventListener("message", (event) => {
      if (!isControllerActive()) {
        deactivateController();
        return;
      }
      if (event.source !== window || event.data?.source !== "browsermcp-page-console") {
        return;
      }
      state.consoleLogs.push(event.data.entry);
      if (state.consoleLogs.length > 200) {
        state.consoleLogs.splice(0, state.consoleLogs.length - 200);
      }
    });
  }

  function isControllerActive() {
    if (state.deactivated) {
      return false;
    }

    try {
      return Boolean(chrome?.runtime?.id);
    } catch (_error) {
      return false;
    }
  }

  function ensureControllerActive() {
    if (!isControllerActive()) {
      deactivateController();
      throw new Error("Extension context invalidated");
    }
  }

  function deactivateController() {
    if (state.deactivated) {
      return;
    }

    state.deactivated = true;
    clearTimeout(state.snapshotTimer);
    state.snapshotTimer = null;
    clearReconnectTimer();
    state.mutationObserver?.disconnect();
    state.mutationObserver = null;
    if (state.domReadyListener) {
      window.removeEventListener("DOMContentLoaded", state.domReadyListener);
      state.domReadyListener = null;
    }
    disconnectSocket();
  }

  function getExtensionVersion() {
    try {
      return chrome.runtime.getManifest().version;
    } catch (_error) {
      return undefined;
    }
  }

  function wait(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
})();

export type SnapshotMode = "full" | "delta";

export type BrowserActionRef = {
  element?: string;
  ref: string;
  expectedVersion?: number;
};

export type BrowserConsoleEntry = {
  level: "log" | "info" | "warn" | "error";
  args: string[];
  timestamp: string;
  source?: "page" | "run_js";
};

export type BrowserConsoleEntryNotification = {
  entry: BrowserConsoleEntry;
  runId?: string;
};

export type BrowserRunJsPayload = {
  code: string;
  args?: unknown;
  runId?: string;
  timeoutMs?: number;
  expectedVersion?: number;
};

export type BrowserRunJsError = {
  message: string;
  name?: string;
  stack?: string;
};

export type BrowserRunJsResult = {
  success: boolean;
  result?: unknown;
  error?: BrowserRunJsError;
  logs: BrowserConsoleEntry[];
  runId?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
};

export type BrowserRefDescription = {
  ref: string;
  nodeId: string;
  role?: string;
  name?: string;
  value?: string;
  description?: string;
  page: BrowserPageState;
  htmlTag: string;
  text?: string;
  attributes: Record<string, string>;
  states: Record<string, boolean | string | number>;
  context: {
    landmark?: string;
    heading?: string;
    form?: string;
  };
  actions: string[];
  nearbyRefs: Array<{
    ref: string;
    role?: string;
    name?: string;
  }>;
};

export type BrowserSessionCapabilities = {
  structuredSnapshots: boolean;
  versionedSnapshots: boolean;
  invalidationEvents: boolean;
  partialInvalidation: boolean;
};

export type BrowserPageState = {
  url: string;
  title: string;
  tabId?: number;
  windowId?: number;
  faviconUrl?: string;
};

export type BrowserSnapshotNode = {
  nodeId: string;
  ref?: string;
  role?: string;
  name?: string;
  value?: string;
  description?: string;
  properties?: Record<string, unknown>;
  children?: BrowserSnapshotNode[];
};

export type BrowserInvalidationEvent = {
  version: number;
  timestamp: string;
  reason:
    | "navigation"
    | "mutation"
    | "input"
    | "history"
    | "reload"
    | "frame"
    | "unknown";
  scope: "full" | "subtree";
  nodeIds?: string[];
  summary?: string;
};

export type BrowserStructuredSnapshot = {
  version: number;
  generatedAt: string;
  format: "aria-tree-v1" | "semantic-tree-v1";
  mode: SnapshotMode;
  root: BrowserSnapshotNode[];
  invalidation?: BrowserInvalidationEvent | null;
};

export type BrowserSnapshotResponse = {
  page: BrowserPageState;
  snapshot: BrowserStructuredSnapshot;
};

export type BrowserSessionHello = {
  page: BrowserPageState;
  extensionVersion?: string;
  browserName?: string;
  userAgent?: string;
  capabilities: BrowserSessionCapabilities;
  snapshotVersion?: number;
};

export type BrowserPageUpdate = {
  page: BrowserPageState;
  snapshotVersion: number;
  invalidation?: BrowserInvalidationEvent;
};

export type BrowserSnapshotUpdate = {
  page?: BrowserPageState;
  snapshot: BrowserStructuredSnapshot;
};

export type BrowserNotificationMap = {
  "tabductor.session.hello": {
    payload: BrowserSessionHello;
  };
  "tabductor.page.updated": {
    payload: BrowserPageUpdate;
  };
  "tabductor.snapshot.updated": {
    payload: BrowserSnapshotUpdate;
  };
  "tabductor.console.entry": {
    payload: BrowserConsoleEntryNotification;
  };
};

export type BrowserNotificationType = keyof BrowserNotificationMap;

export type BrowserRequestMap = {
  tabductor_snapshot: {
    payload: {
      mode?: SnapshotMode;
      sinceVersion?: number;
    };
    result: BrowserSnapshotResponse;
  };
  tabductor_navigate: {
    payload: {
      url: string;
    };
    result: {
      acknowledged: true;
    };
  };
  tabductor_go_back: {
    payload: {};
    result: {
      acknowledged: true;
    };
  };
  tabductor_go_forward: {
    payload: {};
    result: {
      acknowledged: true;
    };
  };
  tabductor_click: {
    payload: BrowserActionRef;
    result: {
      acknowledged: true;
    };
  };
  tabductor_hover: {
    payload: BrowserActionRef;
    result: {
      acknowledged: true;
    };
  };
  tabductor_type: {
    payload: BrowserActionRef & {
      text: string;
      submit: boolean;
    };
    result: {
      acknowledged: true;
    };
  };
  tabductor_select_option: {
    payload: BrowserActionRef & {
      values: string[];
    };
    result: {
      acknowledged: true;
    };
  };
  tabductor_press_key: {
    payload: {
      key: string;
      expectedVersion?: number;
    };
    result: {
      acknowledged: true;
    };
  };
  tabductor_wait: {
    payload: {
      time: number;
    };
    result: {
      acknowledged: true;
    };
  };
  tabductor_get_console_logs: {
    payload: {};
    result: BrowserConsoleEntry[];
  };
  tabductor_screenshot: {
    payload: {};
    result: string;
  };
  tabductor_describe_ref: {
    payload: {
      ref: string;
    };
    result: BrowserRefDescription;
  };
  tabductor_run_js: {
    payload: BrowserRunJsPayload;
    result: BrowserRunJsResult;
  };
};

export type BrowserRequestType = keyof BrowserRequestMap;

export type RpcRequestEnvelope<T extends BrowserRequestType = BrowserRequestType> = {
  id: string;
  type: T;
  payload: BrowserRequestMap[T]["payload"];
};

export type RpcSuccessEnvelope<T extends BrowserRequestType = BrowserRequestType> = {
  id: string;
  ok: true;
  result: BrowserRequestMap[T]["result"];
};

export type RpcErrorEnvelope = {
  id: string;
  ok: false;
  error: {
    code: string;
    message: string;
    data?: unknown;
  };
};

export type RpcNotificationEnvelope<
  T extends BrowserNotificationType = BrowserNotificationType,
> = {
  event: T;
  payload: BrowserNotificationMap[T]["payload"];
};

export type RpcResponseEnvelope<T extends BrowserRequestType = BrowserRequestType> =
  | RpcSuccessEnvelope<T>
  | RpcErrorEnvelope;

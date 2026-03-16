import type {
  BrowserRequestMap,
  BrowserRequestType,
  BrowserSnapshotResponse,
} from "@/protocol/messages";
import type { BrowserSessionState } from "@/session";

export type DaemonSessionState = BrowserSessionState & {
  revision: number;
};

export type DaemonRequestMap = {
  list_sessions: {
    params: {};
    result: {
      sessions: DaemonSessionState[];
    };
  };
  get_session_state: {
    params: {
      sessionId: string;
    };
    result: {
      session: DaemonSessionState;
    };
  };
  wait_for_state_change: {
    params: {
      sessionId: string;
      revision: number;
      timeoutMs?: number;
    };
    result: {
      changed: boolean;
      session: DaemonSessionState;
    };
  };
  get_cached_snapshot: {
    params: {
      sessionId: string;
      freshness?: "current" | "fresh";
    };
    result: {
      snapshot: BrowserSnapshotResponse | null;
    };
  };
  send_browser_request: {
    params: {
      sessionId: string;
      type: BrowserRequestType;
      payload: BrowserRequestMap[BrowserRequestType]["payload"];
      timeoutMs?: number;
    };
    result: {
      result: BrowserRequestMap[BrowserRequestType]["result"];
    };
  };
};

export type DaemonRequestType = keyof DaemonRequestMap;

export type DaemonRequestEnvelope<T extends DaemonRequestType = DaemonRequestType> = {
  id: string;
  method: T;
  params: DaemonRequestMap[T]["params"];
};

export type DaemonSuccessEnvelope<T extends DaemonRequestType = DaemonRequestType> = {
  id: string;
  ok: true;
  result: DaemonRequestMap[T]["result"];
};

export type DaemonErrorEnvelope = {
  id: string;
  ok: false;
  error: {
    code: string;
    message: string;
  };
};

export type DaemonResponseEnvelope<T extends DaemonRequestType = DaemonRequestType> =
  | DaemonSuccessEnvelope<T>
  | DaemonErrorEnvelope;

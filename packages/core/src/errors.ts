/** The one app error. `code` is a stable machine-readable string (e.g. "config_invalid"). */
export class AppError extends Error {
  readonly code: string;
  /**
   * Machine-readable context — which node, which edge, which event type. The control plane
   * forwards it verbatim to the client so the graph editor can put a validation failure on
   * the offending node instead of in a toast (`docs/subphases/U0-first-ui.md`).
   */
  readonly details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    opts?: { cause?: unknown; details?: Record<string, unknown> },
  ) {
    super(message, opts);
    this.name = "AppError";
    this.code = code;
    this.details = opts?.details ?? {};
  }
}

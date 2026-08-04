/** The one app error. `code` is a stable machine-readable string (e.g. "config_invalid"). */
export class AppError extends Error {
  readonly code: string;

  constructor(code: string, message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = "AppError";
    this.code = code;
  }
}

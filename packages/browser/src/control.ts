import { AppError } from "@tabductor/core";
import type { BrowserConn } from "./driver.js";

/** Retry only commands explicitly rejected before dispatch by the ownership fence. */
export async function withAutomationControl<T>(conn: BrowserConn, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (;;) {
    signal?.throwIfAborted();
    await conn.waitForAutomation?.(signal);
    try { return await operation(); }
    catch (error) {
      if (!conn.waitForAutomation || !(error instanceof AppError) || error.code !== "browser_input_revoked") throw error;
    }
  }
}

import { AsyncLocalStorage } from "node:async_hooks";
export type BrowserOperationContext = { callId?: string; invocationId?: string; operationId?: string; member?: string };
const context = new AsyncLocalStorage<BrowserOperationContext>();
export const currentBrowserOperation = () => context.getStore();
export function withBrowserOperation<T>(value: BrowserOperationContext, fn: () => T): T {
  return context.run({ ...context.getStore(), ...value }, fn);
}

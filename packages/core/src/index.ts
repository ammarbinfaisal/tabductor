export { newId } from "./ids.js";
export { isDevMode } from "./dev-mode.js";
export { AppError } from "./errors.js";
export { estimateModelInput } from "./model-input.js";
export { loadConfig, type Config } from "./config.js";
export { createLogger, type Logger, type LogLevel } from "./logger.js";
export {
  canonicalJson,
  taskContentBasisHash,
  taskContentHash,
  type TaskHashGrant,
  type TaskHashStoreTable,
} from "./task-content-hash.js";

export { AllowAllGate, RuntimeSafetyGate, DEFAULT_TOKEN_PATTERNS, maskText, type PolicyGate, type TaskCtx, type Verdict, type BrowserAction, type NavCause, type ReqRef, type ReadParts, type NetworkPayload } from "./runtime-safety.js";

/** Increment whenever the compiled host-call contract changes incompatibly. */
export const SCRIPT_RUNTIME_VERSION = "tabductor-python-playwright-v1";

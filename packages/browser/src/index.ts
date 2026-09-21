export type {
  Anchor,
  AnchoredElement,
  BrowserConn,
  CreatePageOptions,
  Driver,
  ExtractedRecord,
  ExtractOptions,
  ExtractSpec,
  FieldSpec,
  LocatorStrategy,
  LoadState,
  NavigationOptions,
  WaitOptions,
  NavigationHook,
  NavigationRequest,
  NetworkBody,
  NetworkHeaders,
  NetworkHooks,
  NetworkParts,
  NetworkRecord,
  Page,
  PageInteraction,
  DownloadedFile,
  PerceiveOptions,
  Perception,
  TargetProbe,
} from "./driver.js";
export { playwrightDriver } from "./playwright-driver.js";
export {
  createCamoufoxWorkerDriver,
  type CamoufoxWorkerDriverOptions,
} from "./camoufox-worker-driver.js";
export {
  createMinioBlobStore,
  configuredBlobStore,
  createS3BlobStore,
  type BlobRef,
  type BlobStore,
  type MinioBlobStoreOptions,
} from "./blob-store.js";
export {
  createTraceRecorder,
  type BlobInput,
  type StorageFlags,
  type TraceRecorder,
} from "./trace.js";
export {
  openRunSession,
  NETWORK_READ_PARTS,
  type NetworkApi,
  type NetworkListRecord,
  type NetworkListResult,
  type NetworkReadPart,
  type NetworkReadResult,
  type NetworkWaitOptions,
  type ResourceLimits,
  type RunSession,
  type SessionDeps,
} from "./session.js";
export {
  createEndpointPool,
  type EndpointLease,
  type EndpointPool,
  type EndpointPoolDeps,
} from "./pool.js";
export { resolveCdpWsUrl, CDP_ENDPOINT_UNREACHABLE } from "./cdp-url.js";

export { withAutomationControl } from "./control.js";

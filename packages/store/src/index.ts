export { wfIdsOf, type WorkflowStoreIds } from "./ids.js";
export { fenceQuery, type FenceReason, type FenceResult } from "./fence.js";
export {
  checkDdlShape,
  checkTablesSpecBijective,
  type ColumnAllowedType,
  type DdlCheck,
  type DdlColumn,
  type DdlIssue,
  type DdlTable,
  type StoreTablesSpec,
  type StoreTableSpec,
} from "./ddl.js";
export { classifyMigration, type MigrationDiff } from "./migration.js";
export {
  provision,
  deprovision,
  validateDdlApplies,
  applyMigration,
  currentSchemaVersion,
  type WfConnectionInfo,
} from "./provision.js";
export { runStoreQuery, executeAsReader, type StoreQueryOptions, type StoreQueryResult } from "./query.js";
export {
  validateRow,
  checkStoreWriteGrant,
  createWriteStager,
  stageRowWrite,
  flushStagedWrites,
  type PendingWrite,
  type RowCheck,
} from "./write.js";
export { latestStoreSchema, tablesSpecOf } from "./lookup.js";
export {
  createStoreQueryTool,
  createStoreInsertTool,
  createStoreUpsertTool,
  type StoreTool,
  type StoreToolResult,
  type StoreQueryToolDeps,
  type StoreWriteToolDeps,
} from "./tools.js";

/**
 * Validates a compiled store-schema artifact end to end (deliverable 1): structural DDL
 * shape, the tables_spec bijection, and — given a pool — that the DDL actually applies to a
 * scratch schema. Exported as one call because every caller (the publish path, S8's future
 * gate, this package's own tests) wants all three in the same order, not assembled by hand
 * three times over.
 */
export { validateStoreSchemaArtifact } from "./validate-artifact.js";

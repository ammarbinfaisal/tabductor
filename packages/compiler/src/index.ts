export {
  activateScript,
  getActiveScript,
  insertCandidateScript,
  invalidateScript,
} from "./registry.js";
export {
  recordAiRun,
  recordCompiledRun,
  DEMOTE_DEOPTS,
  DEOPT_WINDOW,
  PROMOTE_AFTER_CLEAN_RUNS,
  type DemotionOutcome,
  type PromotionDeps,
  type PromotionOutcome,
} from "./promotion.js";
export { compileTask, type CompileDeps, type CompileResult, type Llm } from "./compile.js";
export {
  checkConsistency,
  type Anchor,
  type ConsistencyReport,
  type Extraction,
  type RunTrace,
  type Step,
  type TraceEntry,
} from "./consistency.js";
export { lintScript, LINT_RULES, type LintResult, type LintRule, type LintViolation } from "./lint.js";
export { loadRunTraces, previousCleanAiRunIds } from "./traces.js";

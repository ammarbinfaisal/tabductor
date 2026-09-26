export {
  activateScript,
  getActiveScript,
  insertCandidateScript,
  invalidateScript,
} from "./registry.js";
export {
  noteAiRun,
  promoteTask,
  recordCompiledRun,
  DEMOTE_DEOPTS,
  DEOPT_WINDOW,
  PROMOTE_AFTER_CLEAN_RUNS,
  type DemotionOutcome,
  type EligibilityOutcome,
} from "./promotion.js";
export {
  compileTask,
  type CompileDeps,
  type CompileInput,
  type CompileResult,
  type CompileStage,
  type Llm,
} from "./compile.js";
export {
  buildEvidence,
  missingEvidence,
  renderEvidence,
  type ActionEvidence,
  type RunEvidence,
  type RunTrace,
  type TraceEntry,
} from "./evidence.js";
export {
  renderPlan,
  validatePlan,
  workPlanSchema,
  type PlanCheck,
  type PlanStep,
  type WorkPlan,
} from "./plan.js";
export { validateCandidate, type ValidationResult } from "./validate.js";
export {
  claimCompileJob,
  enqueueCompileJob,
  finishCompileJob,
  heartbeatCompileJob,
  taskForJob,
  COMPILE_JOB_STALE_MS,
  COMPILE_RETRY_DELAY_MS,
} from "./jobs.js";
export { lintScript, LINT_RULES, type LintResult, type LintRule, type LintViolation } from "./lint.js";
export { loadRunTraces, previousCleanAiRunIds } from "./traces.js";

export { validateSdkCandidate, lintSdkScript } from "./sdk-validate.js";
export {
  readSdkEvidence,
  checkSdkPlan,
  isPlannedDeopt,
  sdkPlanSchema,
  PLANNED_DEOPT_EVIDENCE_KEY,
  type SdkPlan,
  type SdkEvidence,
} from "./sdk-evidence.js";

import { findBillingRate, recordCost } from "./billing-prices.js";
import { usdMicros } from "@tabductor/core";
import { AppError, newId } from "@tabductor/core";
import { modelCredentials, modelSelections, modelOperations, workflowExecutions, workflows, workflowVersions, runs, tasks, type Db } from "@tabductor/db";
import { encryptEnvelope, withEnvelope, zero, type KeyWrapper } from "@tabductor/secrets";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { reserveCredits, settleCreditReservation } from "./credits.js";

export const modelProviderSchema = z.enum(["openai", "anthropic", "openai-compatible"]);
export type ModelProvider = z.infer<typeof modelProviderSchema>;
const platformModelProviderSchema = z.enum(["openai", "anthropic"]);
const compatibleBaseUrlSchema = z.string().trim().min(1).max(2048).url().refine((value) => {
  const url = new URL(value);
  return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !url.search && !url.hash;
}, "base URL must be an http(s) URL without credentials, query parameters, or a fragment");

export const modelCredentialInputSchema = z.object({
  provider: modelProviderSchema,
  label: z.string().trim().min(1).max(120),
  apiKey: z.string().min(1).max(4096),
  baseUrl: compatibleBaseUrlSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.provider === "openai-compatible" && !value.baseUrl) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["baseUrl"], message: "an OpenAI-compatible credential requires a base URL" });
  }
  if (value.provider !== "openai-compatible" && value.baseUrl) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["baseUrl"], message: "a base URL is only supported for OpenAI-compatible credentials" });
  }
});

export const modelSelectionSchema = z.object({
  scope: z.string().min(1).max(200).default("account"),
  funding: z.enum(["byo", "platform"]),
  provider: modelProviderSchema,
  model: z.string().trim().min(1).max(200),
  credentialId: z.string().min(1).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.funding === "byo" ? !value.credentialId : Boolean(value.credentialId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["credentialId"], message: "BYO requires a credential; platform models must not specify one" });
  }
  if (value.funding === "platform" && !platformModelProviderSchema.safeParse(value.provider).success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["provider"], message: "OpenAI-compatible models require your own credential" });
  }
});

const rateSchema = z.object({
  provider: z.enum(["openai", "anthropic"]), model: z.string().min(1), version: z.string().min(1),
  // Integer USD micro-units per million tokens; parseModelRates converts decimal USD inputs.
  input: z.number().int().positive().safe(), cachedInput: z.number().int().nonnegative().safe(), output: z.number().int().positive().safe(),
  maxInputTokens: z.number().int().min(1024).max(2_000_000), maxOutputTokens: z.number().int().min(1).max(2_000_000),
}).strict();
export type ModelRate = z.infer<typeof rateSchema>;
export type ModelUsage = { input: number; output: number; cachedInput?: number; reasoning?: number };
export type ModelPurpose = "authoring" | "schema" | "graph" | "prompt" | "runtime" | "recovery" | "trace_compilation" | "browser_learning";
export type ModelScope = { accountId: string; workflowId?: string; runId?: string; purpose: ModelPurpose };
export type ModelCallConfig = { provider: ModelProvider; model: string; apiKey: string; baseUrl?: string; maxOutputTokens: number };

export function parseModelRates(value: string | undefined): ModelRate[] {
  if (!value) return [];
  try {
    const json=JSON.parse(value) as Record<string,unknown>[];
    const rates = z.array(rateSchema).max(100).parse(json.map(({inputUsd,cachedInputUsd,outputUsd,...r})=>inputUsd===undefined?r:{...r,input:usdMicros(String(inputUsd)),cachedInput:usdMicros(String(cachedInputUsd??"0")),output:usdMicros(String(outputUsd))}));
    if (new Set(rates.map((r) => `${r.provider}:${r.model}`)).size !== rates.length) throw new Error("duplicate");
    return rates;
  } catch { throw new AppError("model_rates_invalid", "model rates must contain unique, explicitly versioned provider/model rates and limits"); }
}

export async function saveModelCredential(db: Db, wrapper: KeyWrapper,
  input: { accountId: string } & z.input<typeof modelCredentialInputSchema>) {
  const { accountId, ...credentialInput } = input;
  const validated = modelCredentialInputSchema.parse(credentialInput);
  if (!validated.apiKey.trim()) throw new AppError("model_credential_invalid", "a provider API key is required");
  const value = Buffer.from(validated.apiKey);
  try {
    const envelope = await encryptEnvelope(wrapper, value);
    const [row] = await db.insert(modelCredentials).values({ id: newId("modelkey"), accountId,
      provider: validated.provider, label: validated.label, baseUrl: validated.baseUrl ?? null, envelope }).returning({ id: modelCredentials.id, provider: modelCredentials.provider, label: modelCredentials.label, baseUrl: modelCredentials.baseUrl });
    return row!;
  } finally { zero(value); }
}

async function assertWorkflow(db: Db, accountId: string, workflowId: string) {
  const [row] = await db.select({ id: workflows.id }).from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.accountId, accountId)));
  if (!row) throw new AppError("workflow_not_found", "workflow not found");
}

export async function setModelSelection(db: Db, accountId: string, value: z.input<typeof modelSelectionSchema>) {
  const input = modelSelectionSchema.parse(value);
  return db.transaction(async (trx) => {
    if (input.scope !== "account") await assertWorkflow(trx, accountId, input.scope);
    if (input.credentialId) {
      const [credential] = await trx.select({ id: modelCredentials.id }).from(modelCredentials).where(and(
        eq(modelCredentials.id, input.credentialId), eq(modelCredentials.accountId, accountId),
        eq(modelCredentials.provider, input.provider), isNull(modelCredentials.revokedAt))).for("share");
      if (!credential) throw new AppError("model_credential_missing", "model credential is unavailable");
    }
    const row = { ...input, accountId, credentialId: input.credentialId ?? null, updatedAt: new Date() };
    await trx.insert(modelSelections).values(row).onConflictDoUpdate({ target: [modelSelections.accountId, modelSelections.scope], set: row });
  });
}

export async function modelScopeForTask(db: Db, taskId: string, purpose: ModelPurpose, runId?: string): Promise<ModelScope> {
  const [row] = await db.select({ accountId: workflows.accountId, workflowId: workflows.id }).from(tasks)
    .innerJoin(workflowVersions, eq(tasks.workflowVersionId, workflowVersions.id))
    .innerJoin(workflows, eq(workflowVersions.workflowId, workflows.id)).where(eq(tasks.id, taskId));
  if (!row) throw new AppError("task_not_found", "model task not found");
  return { ...row, purpose, ...(runId ? { runId } : {}) };
}

function validateUsage(usage: ModelUsage) {
  for (const n of [usage.input, usage.output, usage.cachedInput ?? 0, usage.reasoning ?? 0]) {
    if (!Number.isSafeInteger(n) || n < 0) throw new AppError("model_usage_invalid", "provider did not return valid token usage");
  }
  if ((usage.cachedInput ?? 0) > usage.input || (usage.reasoning ?? 0) > usage.output) {
    throw new AppError("model_usage_invalid", "token categories exceed their totals");
  }
}

export function modelCreditUnits(rate: Pick<ModelRate, "input" | "cachedInput" | "output">, usage: ModelUsage): number {
  validateUsage(usage);
  const cached = usage.cachedInput ?? 0;
  const numerator = BigInt(usage.input - cached) * BigInt(rate.input) + BigInt(cached) * BigInt(rate.cachedInput) + BigInt(usage.output) * BigInt(rate.output);
  const units = Number((numerator + 999_999n) / 1_000_000n);
  if (!Number.isSafeInteger(units)) throw new AppError("model_cost_overflow", "model charge exceeds the supported range");
  return units;
}

export type ModelResolver = ReturnType<typeof createModelResolver>;
export function createModelResolver(deps: { db: Db; wrapper: KeyWrapper; rates: ModelRate[];
  platformKeys: Partial<Record<"openai" | "anthropic", string>> }) {
  return {
    async execute<T>(scope: ModelScope, input: { operationId?: string; inputTokenBound: number },
      call: (config: ModelCallConfig) => Promise<{ value: T; usage: ModelUsage }>): Promise<T> {
      if (!Number.isSafeInteger(input.inputTokenBound) || input.inputTokenBound <= 0) throw new AppError("model_input_invalid", "model input bound must be positive");
      if (scope.workflowId) await assertWorkflow(deps.db, scope.accountId, scope.workflowId);
      let pinned: typeof workflowExecutions.$inferSelect.modelSelectionJson | undefined;
      if (scope.runId) {
        const [run] = await deps.db.select({ taskId: runs.taskId, executionId: runs.executionId }).from(runs).where(eq(runs.id, scope.runId));
        if (!run) throw new AppError("run_not_found", "model run not found");
        const owner = await modelScopeForTask(deps.db, run.taskId, scope.purpose);
        if (owner.accountId !== scope.accountId || owner.workflowId !== scope.workflowId) throw new AppError("run_not_found", "model run not found");
        if (run.executionId) {
          const [execution] = await deps.db.select({ selection: workflowExecutions.modelSelectionJson }).from(workflowExecutions)
            .where(and(eq(workflowExecutions.id, run.executionId), eq(workflowExecutions.workflowId, owner.workflowId!)));
          if (!execution) throw new AppError("execution_not_found", "model execution not found");
          pinned = execution.selection;
        }
      }
      const selections = await deps.db.select().from(modelSelections).where(eq(modelSelections.accountId, scope.accountId));
      const selection = pinned !== undefined ? pinned : selections.find((s) => s.scope === scope.workflowId) ?? selections.find((s) => s.scope === "account");
      if (!selection) throw new AppError("model_selection_missing", "Choose a model source in account settings before using AI");
      let rate = deps.rates.find((r) => r.provider === selection.provider && r.model === selection.model);
      const [inputRate,cachedRate,outputRate]=await Promise.all(["input","cached","output"].map(part=>findBillingRate(deps.db,"model",selection.provider,`${selection.model}:${part}`)));
      if(inputRate&&outputRate)rate={provider:selection.provider as "openai"|"anthropic",model:selection.model,version:inputRate.id,input:inputRate.chargeMicros,
        cachedInput:cachedRate?.chargeMicros??inputRate.chargeMicros,output:outputRate.chargeMicros,
        maxInputTokens:inputRate.maxInputTokens??rate?.maxInputTokens??128000,maxOutputTokens:inputRate.maxOutputTokens??rate?.maxOutputTokens??8192};
      if (selection.funding === "platform" && !rate) throw new AppError("model_rate_unknown", "this platform model has no configured rate");
      const maxInput = rate?.maxInputTokens ?? 128_000;
      const maxOutputTokens = rate?.maxOutputTokens ?? 8192;
      if (input.inputTokenBound > maxInput) throw new AppError("model_input_limit",
        `model input estimate ${input.inputTokenBound} exceeds configured limit ${maxInput}; compact history or reduce tool data`,
        { details: { estimatedInputTokens: input.inputTokenBound, maxInputTokens: maxInput } });
      const [credential] = selection.funding === "byo" ? await deps.db.select().from(modelCredentials).where(and(
        eq(modelCredentials.id, selection.credentialId!), eq(modelCredentials.accountId, scope.accountId),
        eq(modelCredentials.provider, selection.provider), isNull(modelCredentials.revokedAt))) : [];
      if (selection.funding === "byo" && !credential) throw new AppError("model_credential_missing", "the selected BYO credential is unavailable");
      const platformKey = selection.provider === "openai-compatible" ? undefined : deps.platformKeys[selection.provider];
      if (selection.funding === "platform" && !platformKey) throw new AppError("model_platform_unavailable", "the selected platform provider is unavailable");
      const id = input.operationId ?? newId("modelop");
      await deps.db.transaction(async (trx) => {
        const [admitted] = await trx.insert(modelOperations).values({ id, ...scope, funding: selection.funding,
          provider: selection.provider, model: selection.model,
          rateVersion: selection.funding === "platform" ? rate!.version : null,
          rateJson: selection.funding === "platform" ? { input: rate!.input, cachedInput: rate!.cachedInput, output: rate!.output } : null,
        }).onConflictDoNothing().returning({ id: modelOperations.id });
        if (!admitted) throw new AppError("model_operation_exists", "model operation already submitted; reconcile its outcome before retrying");
        if (selection.funding === "platform") {
          const units = modelCreditUnits({ ...rate!, input: Math.max(rate!.input, rate!.cachedInput) }, { input: maxInput, output: maxOutputTokens });
          const reservation = await reserveCredits(trx, { accountId: scope.accountId, operationId: id, category: "model", units });
          await trx.update(modelOperations).set({ reservationId: reservation.id }).where(eq(modelOperations.id, id));
        }
      });
      try {
        const invoke = (apiKey: string) => call({ provider: selection.provider, model: selection.model, apiKey,
          ...(credential?.baseUrl ? { baseUrl: credential.baseUrl } : {}), maxOutputTokens });
        const result = credential ? await withEnvelope(deps.wrapper, credential.envelope, (value) => invoke(value.toString("utf8"))) : await invoke(platformKey!);
        if(selection.funding==="platform") await recordCost(deps.db,{category:"model",provider:selection.provider,accountId:scope.accountId,sourceId:id,
          ...(inputRate?{rateId:inputRate.id}:{}),costMicros:inputRate?.costMicros!=null&&outputRate?.costMicros!=null?
            modelCreditUnits({input:inputRate.costMicros,cachedInput:cachedRate?.costMicros??inputRate.costMicros,output:outputRate.costMicros},result.usage):null});
        validateUsage(result.usage);
        // Persist observed usage before settlement, so an unexpected provider overrun remains reconcilable.
        await deps.db.update(modelOperations).set({ inputTokens: result.usage.input, outputTokens: result.usage.output,
          cachedInputTokens: result.usage.cachedInput ?? 0, reasoningTokens: result.usage.reasoning ?? 0,
        }).where(eq(modelOperations.id, id));
        await settleModelOperation(deps.db, scope.accountId, id);
        return result.value;
      } catch {
        if(selection.funding==="platform")await recordCost(deps.db,{category:"model",provider:selection.provider,accountId:scope.accountId,sourceId:id,costMicros:null});
        await deps.db.update(modelOperations).set({ status: "uncertain" }).where(and(eq(modelOperations.id, id), eq(modelOperations.status, "pending")));
        // Provider errors may embed request headers. Never return their text, cause, or body.
        throw new AppError("model_operation_uncertain", "Model call failed; its usage is retained for reconciliation. The selected funding source was not changed.", { details: { operationId: id } });
      }
    },
  };
}

/** Safe to repeat after a DB outage. Unknown provider outcomes keep their reservation. */
export async function settleModelOperation(db: Db, accountId: string, id: string): Promise<void> {
  await db.transaction(async (trx) => {
    const [op] = await trx.select().from(modelOperations).where(and(eq(modelOperations.id, id), eq(modelOperations.accountId, accountId))).for("update");
    if (!op) throw new AppError("model_operation_missing", "model operation not found");
    if (op.status === "succeeded") return;
    if (op.inputTokens === null || op.outputTokens === null) throw new AppError("model_usage_unknown", "provider usage is not known");
    const units = op.funding === "platform" && op.rateJson ? modelCreditUnits(op.rateJson,
      { input: op.inputTokens, output: op.outputTokens, cachedInput: op.cachedInputTokens ?? 0, reasoning: op.reasoningTokens ?? 0 }) : 0;
    if (op.reservationId) await settleCreditReservation(trx, { accountId, reservationId: op.reservationId, actualUnits: units });
    await trx.update(modelOperations).set({ status: "succeeded", chargedUnits: units, completedAt: sql`now()` }).where(eq(modelOperations.id, id));
  });
}

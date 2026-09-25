import { and, desc, eq, isNull } from "drizzle-orm";
import { browserPromptRevisions, tasks, type Db, type TaskRow } from "@tabductor/db";
import { browserLearningDefinition, newId, renderLearnedPrompt, SCRIPT_RUNTIME_VERSION, type BrowserProcedure } from "@tabductor/core";

export async function latestBrowserPrompt(db: Db, taskId: string, contentHash: string | null, lane: "ai" | "deopt", scopeKey = "") {
  const [revision] = await db.select().from(browserPromptRevisions).where(and(
    eq(browserPromptRevisions.taskId, taskId), eq(browserPromptRevisions.lane, lane),
    eq(browserPromptRevisions.scopeKey, scopeKey), eq(browserPromptRevisions.runtimeVersion, SCRIPT_RUNTIME_VERSION),
    contentHash === null ? isNull(browserPromptRevisions.contentHash) : eq(browserPromptRevisions.contentHash, contentHash),
  )).orderBy(desc(browserPromptRevisions.revision)).limit(1);
  return revision;
}

/** Snapshot only completed learning; another run or a slow learner never blocks this read. */
export async function browserOperatingPrompt(db: Db, snapshot: TaskRow) {
  const [current] = await db.select().from(tasks).where(eq(tasks.id, snapshot.id));
  const task = current && browserLearningDefinition(current) === browserLearningDefinition(snapshot) ? current : snapshot;
  const revision = task.learningRuntimeVersion === SCRIPT_RUNTIME_VERSION
    ? await latestBrowserPrompt(db, task.id, task.contentHash, "ai") : undefined;
  const baseline = task.baselineCompiledPrompt ?? task.prompt;
  return {
    prompt: revision ? revision.prompt : task.learningRuntimeVersion ? baseline : task.compiledPrompt ?? task.prompt,
    revision: revision?.revision ?? 0,
  };
}

/** Called in the publish transaction, after carrying an unchanged artifact when applicable. */
export async function carryBrowserLearning(db: Db, input: {
  previousTaskId: string; taskId: string; contentHash: string; baseline: string;
  samePromptContext: boolean; artifactKey?: string;
}) {
  const revisions = await db.select().from(browserPromptRevisions).where(and(
    eq(browserPromptRevisions.taskId, input.previousTaskId),
    eq(browserPromptRevisions.contentHash, input.contentHash),
    eq(browserPromptRevisions.runtimeVersion, SCRIPT_RUNTIME_VERSION),
  )).orderBy(desc(browserPromptRevisions.revision));
  const seen = new Set<string>();
  let revision = 0;
  for (const prior of revisions) {
    const key = `${prior.lane}:${prior.scopeKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (prior.lane === "deopt" && (!input.artifactKey || !prior.scopeKey.startsWith(`${input.artifactKey}:`))) continue;
    const data = { ...prior.dataJson };
    if (prior.lane === "ai" && !input.samePromptContext) {
      // A changed graph brief owns routing/contracts. Carry observations, not obsolete prose.
      data.procedure = { ...(data.procedure as BrowserProcedure), instructions: "" };
    }
    const prompt = prior.lane === "ai" ? renderLearnedPrompt(input.baseline, data.procedure as BrowserProcedure) : prior.prompt;
    await db.insert(browserPromptRevisions).values({
      ...prior, id: newId("bprompt"), taskId: input.taskId, previousRevisionId: prior.id,
      baselinePrompt: prior.lane === "ai" ? input.baseline : prior.baselinePrompt, prompt, dataJson: data,
      createdAt: new Date(),
    });
    revision = Math.max(revision, prior.revision);
    if (prior.lane === "ai") await db.update(tasks).set({ compiledPrompt: prompt }).where(eq(tasks.id, input.taskId));
  }
  if (revision) await db.update(tasks).set({ learningRevision: revision, learningRuntimeVersion: SCRIPT_RUNTIME_VERSION }).where(eq(tasks.id, input.taskId));
}

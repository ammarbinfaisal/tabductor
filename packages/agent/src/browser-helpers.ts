import ts from "typescript";
import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { browserHelpers, workflowVersions, type Db } from "@tabductor/db";
import { assertRunLease, type RunHandle } from "@tabductor/engine";
import type { HelperRevision } from "@tabductor/static-rt";

export interface BrowserHelperStore {
  list(): Promise<HelperRevision[]>;
  define(name: string, source: string): Promise<HelperRevision>;
}

/** Helpers have no top-level execution, so a broken definition cannot poison later cells. */
export function validateHelperSource(source: string): void {
  const file = ts.createSourceFile("helper.js", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  const statements = file.statements.filter(node=>!ts.isEmptyStatement(node));
  const node = statements[0];
  const exportedFunction = node && ts.isFunctionDeclaration(node) && node.modifiers?.some(m=>m.kind===ts.SyntaxKind.DefaultKeyword) && node.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword);
  const exportedExpression = node && ts.isExportAssignment(node) && (ts.isArrowFunction(node.expression) || ts.isFunctionExpression(node.expression));
  if (diagnostics?.length || statements.length !== 1 || !exportedFunction && !exportedExpression)
    throw new Error("Helper must contain only an export default function(api,args); put local declarations inside that function");
  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      throw new Error("Imports are unavailable in browser helpers");
    ts.forEachChild(node, walk);
  };
  walk(file);
}

export function browserHelperStore(db: Db, handle: RunHandle, language: "javascript" | "python" = "javascript"): BrowserHelperStore {
  const scope = async () => {
    const [version] = await db.select({ workflowId: workflowVersions.workflowId }).from(workflowVersions)
      .where(eq(workflowVersions.id, handle.task.workflowVersionId));
    if (!version) throw new Error("workflow_version_missing");
    return { workflowId: version.workflowId, taskName: handle.task.name, contentHash: (handle.task.contentHash ?? handle.task.id) + ":playwright-python-v1" };
  };
  return {
    async list() {
      const s = await scope();
      const rows = await db.selectDistinctOn([browserHelpers.name]).from(browserHelpers).where(and(
        eq(browserHelpers.workflowId, s.workflowId), eq(browserHelpers.taskName, s.taskName), eq(browserHelpers.contentHash, s.contentHash),
        eq(browserHelpers.language, language),
      )).orderBy(browserHelpers.name, desc(browserHelpers.createdAt), desc(browserHelpers.revision));
      return rows.map(({ name, revision, source }) => ({ name, revision, source }));
    },
    async define(name, source) {
      if (language === "javascript") validateHelperSource(source);
      const s = await scope();
      const revision = createHash("sha256").update(language === "javascript" ? source : `python:${source}`).digest("hex");
      await db.transaction(async trx => {
        await assertRunLease(trx, handle.run.id, handle.run.leaseGeneration);
        // Serialize definitions across tab/run leases of the same logical task.
        await trx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(s)}, 0))`);
        const rows = await trx.select({ name: browserHelpers.name }).from(browserHelpers).where(and(
          eq(browserHelpers.workflowId, s.workflowId), eq(browserHelpers.taskName, s.taskName), eq(browserHelpers.contentHash, s.contentHash),
        ));
        if (rows.length >= 256 || new Set(rows.map(r => r.name)).size >= 32 && !rows.some(r => r.name === name))
          throw new Error("Helper library limit reached (32 names, 256 revisions per task definition)");
        await trx.insert(browserHelpers).values({ ...s, name, revision, source, language, createdByRunId: handle.run.id }).onConflictDoNothing();
      });
      return { name, revision, source };
    },
  };
}

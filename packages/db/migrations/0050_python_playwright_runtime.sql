-- Python and Playwright evidence cannot replay older JavaScript/harness programs.
UPDATE "compiled_scripts" SET "status" = 'invalidated'
WHERE "status" IN ('active', 'candidate')
  AND ("guards_meta"->>'apiVersion' IS DISTINCT FROM 'playwright-python-v1'
    OR "guards_meta"->>'language' IS DISTINCT FROM 'python');
--> statement-breakpoint
UPDATE "tasks" SET "mode" = 'ai', "clean_ai_runs" = 0, "recent_deopts" = '[]'::jsonb
WHERE "kind" = 'browser' AND "mode" = 'compiled'
  AND NOT EXISTS (SELECT 1 FROM "compiled_scripts" s WHERE s.task_id = tasks.id AND s.status = 'active');
--> statement-breakpoint
UPDATE "compile_jobs" SET "status" = 'refused', "ended_at" = now(),
  "error" = 'Python Playwright runtime requires fresh evidence'
WHERE "status" IN ('queued', 'running');

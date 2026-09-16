ALTER TABLE "asset_versions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "asset_write_grants" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assets" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mcp_servers" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "asset_versions" CASCADE;--> statement-breakpoint
DROP TABLE "asset_write_grants" CASCADE;--> statement-breakpoint
DROP TABLE "assets" CASCADE;--> statement-breakpoint
DROP TABLE "mcp_servers" CASCADE;--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_kind_check";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_kind_mode_check";--> statement-breakpoint
UPDATE "tasks"
SET "kind" = 'decision',
    "mode" = CASE WHEN "mode" IN ('compiled', 'python') THEN 'ai' ELSE "mode" END
WHERE "kind" = 'asset';--> statement-breakpoint
UPDATE "workflow_versions" AS wv
SET "graph_json" = jsonb_set(
  wv."graph_json",
  '{tasks}',
  COALESCE(
    (
      SELECT jsonb_agg(
        CASE
          WHEN task->>'kind' = 'asset' THEN
            jsonb_set(
              jsonb_set(task, '{kind}', '"decision"'::jsonb),
              '{mode}',
              CASE WHEN task->>'mode' IN ('compiled', 'python') THEN '"ai"'::jsonb ELSE task->'mode' END
            )
          ELSE task
        END
        ORDER BY ordinal
      )
      FROM jsonb_array_elements(COALESCE(wv."graph_json"->'tasks', '[]'::jsonb))
        WITH ORDINALITY AS entries(task, ordinal)
    ),
    '[]'::jsonb
  )
)
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements(COALESCE(wv."graph_json"->'tasks', '[]'::jsonb)) AS task
  WHERE task->>'kind' = 'asset'
);--> statement-breakpoint
DELETE FROM "task_grants" WHERE "grant_key" IN ('mcp.call', 'asset.write');--> statement-breakpoint
DELETE FROM "proposed_grants" WHERE "grant_key" IN ('mcp.call', 'asset.write');--> statement-breakpoint
ALTER TABLE "engine_status" DROP COLUMN "capabilities";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_kind_check" CHECK ("tasks"."kind" in ('browser','decision'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_kind_mode_check" CHECK (not ("tasks"."kind" = 'decision' and "tasks"."mode" = 'compiled'));

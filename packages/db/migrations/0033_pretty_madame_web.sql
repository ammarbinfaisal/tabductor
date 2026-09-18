ALTER TABLE "workflow_executions" ADD COLUMN "max_runs" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN "admitted_runs" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_budget_check" CHECK ("workflow_executions"."max_runs" > 0 and "workflow_executions"."admitted_runs" >= 0);--> statement-breakpoint
UPDATE "workflow_executions" x SET "admitted_runs" = (
  SELECT count(*)::integer FROM "runs" r WHERE r.execution_id = x.id
);

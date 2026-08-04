ALTER TABLE "runs" ADD COLUMN "deadline_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "runs_deadline_idx" ON "runs" USING btree ("status","deadline_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_version_name_key" ON "tasks" USING btree ("workflow_version_id","name");
CREATE TABLE "compiled_scripts" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"version" integer NOT NULL,
	"source" text NOT NULL,
	"guards_meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"from_runs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compiled_scripts_status_check" CHECK ("compiled_scripts"."status" in ('candidate','active','invalidated'))
);
--> statement-breakpoint
ALTER TABLE "compiled_scripts" ADD CONSTRAINT "compiled_scripts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "compiled_scripts_task_version_key" ON "compiled_scripts" USING btree ("task_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "compiled_scripts_active_task_key" ON "compiled_scripts" USING btree ("task_id") WHERE "compiled_scripts"."status" = 'active';
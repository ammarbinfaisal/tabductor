CREATE TABLE "store_schemas" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"version" integer NOT NULL,
	"description_text" text DEFAULT '' NOT NULL,
	"ddl" text NOT NULL,
	"tables_spec_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"migration_sql" text DEFAULT '' NOT NULL,
	"migration_class" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_schemas_migration_class_check" CHECK ("store_schemas"."migration_class" in ('none','additive','destructive'))
);
--> statement-breakpoint
CREATE TABLE "store_write_grants" (
	"task_id" text NOT NULL,
	"table_name" text NOT NULL,
	CONSTRAINT "store_write_grants_task_id_table_name_pk" PRIMARY KEY("task_id","table_name")
);
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_kind_check";--> statement-breakpoint
ALTER TABLE "store_schemas" ADD CONSTRAINT "store_schemas_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_write_grants" ADD CONSTRAINT "store_write_grants_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "store_schemas_workflow_version_key" ON "store_schemas" USING btree ("workflow_id","version");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_kind_check" CHECK ("tasks"."kind" in ('browser','asset','decision'));
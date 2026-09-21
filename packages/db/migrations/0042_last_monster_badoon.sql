CREATE TABLE "browser_tab_leases" (
	"session_id" text NOT NULL,
	"tab_key" text NOT NULL,
	"run_id" text,
	"run_generation" integer,
	"task_id" text,
	CONSTRAINT "browser_tab_leases_session_id_tab_key_pk" PRIMARY KEY("session_id","tab_key")
);
--> statement-breakpoint
ALTER TABLE "browser_tab_leases" ADD CONSTRAINT "browser_tab_leases_session_id_browser_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."browser_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_tab_leases" ADD CONSTRAINT "browser_tab_leases_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_tab_leases" ADD CONSTRAINT "browser_tab_leases_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
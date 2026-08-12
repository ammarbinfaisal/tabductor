CREATE TABLE "asset_versions" (
	"asset_id" text NOT NULL,
	"version" integer NOT NULL,
	"blob_ref" text NOT NULL,
	"sha256" text NOT NULL,
	"size" integer NOT NULL,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_versions_asset_id_version_pk" PRIMARY KEY("asset_id","version")
);
--> statement-breakpoint
CREATE TABLE "asset_write_grants" (
	"task_id" text NOT NULL,
	"path_glob" text NOT NULL,
	CONSTRAINT "asset_write_grants_task_id_path_glob_pk" PRIMARY KEY("task_id","path_glob")
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"path" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"blob_ref" text NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "asset_versions" ADD CONSTRAINT "asset_versions_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_write_grants" ADD CONSTRAINT "asset_write_grants_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_user_path_key" ON "assets" USING btree ("user_id","path");
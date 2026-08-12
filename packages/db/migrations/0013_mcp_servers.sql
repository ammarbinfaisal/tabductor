CREATE TABLE "mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"transport" text NOT NULL,
	"config_json" jsonb NOT NULL,
	"secret_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_transport_check" CHECK ("mcp_servers"."transport" in ('stdio','http'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_user_label_key" ON "mcp_servers" USING btree ("user_id","label");
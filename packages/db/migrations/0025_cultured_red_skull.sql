CREATE TABLE "account_identities" (
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"account_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_identities_provider_subject_pk" PRIMARY KEY("provider","subject")
);
--> statement-breakpoint
CREATE TABLE "account_mcp_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"token_sha256" text NOT NULL,
	"token_prefix" text NOT NULL,
	"label" text DEFAULT 'MCP token' NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "accounts" ("id", "name") VALUES ('acct_local', 'Local account') ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "account_id" text;--> statement-breakpoint
UPDATE "workflows" SET "account_id" = 'acct_local' WHERE "account_id" IS NULL;--> statement-breakpoint
ALTER TABLE "workflows" ALTER COLUMN "account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "account_identities" ADD CONSTRAINT "account_identities_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_mcp_tokens" ADD CONSTRAINT "account_mcp_tokens_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_identities_account_idx" ON "account_identities" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_mcp_tokens_hash_key" ON "account_mcp_tokens" USING btree ("token_sha256");--> statement-breakpoint
CREATE INDEX "account_mcp_tokens_account_idx" ON "account_mcp_tokens" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
UPDATE "approvals" SET "status" = 'cancelled', "decided_at" = now() WHERE "status" = 'pending';
--> statement-breakpoint
UPDATE "runs" SET "status" = 'cancelled', "ended_at" = now(), "error" = 'legacy approval wait retired'
WHERE "status" = 'awaiting_approval';

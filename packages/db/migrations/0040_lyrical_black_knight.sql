CREATE TABLE "browser_profile_imports" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"origin" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "browser_profiles" ADD COLUMN "pending_auth_envelope" jsonb;--> statement-breakpoint
ALTER TABLE "browser_profile_imports" ADD CONSTRAINT "browser_profile_imports_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_profile_imports" ADD CONSTRAINT "browser_profile_imports_profile_id_browser_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."browser_profiles"("id") ON DELETE cascade ON UPDATE no action;
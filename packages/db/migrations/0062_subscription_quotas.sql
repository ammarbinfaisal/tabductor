CREATE TABLE plan_revisions (
 id text PRIMARY KEY, slug text NOT NULL, revision integer NOT NULL CHECK(revision > 0), name text NOT NULL,
 monthly_micros bigint NOT NULL CHECK(monthly_micros >= 0), concurrent_browsers integer NOT NULL CHECK(concurrent_browsers > 0),
 browser_ms bigint NOT NULL CHECK(browser_ms >= 0), workflow_runs integer NOT NULL CHECK(workflow_runs >= 0),
 proxy_bytes bigint NOT NULL CHECK(proxy_bytes >= 0), captcha boolean NOT NULL,
 browser_hour_micros bigint CHECK(browser_hour_micros >= 0), proxy_gb_micros bigint CHECK(proxy_gb_micros >= 0),
 paddle_price_id text UNIQUE, public boolean NOT NULL DEFAULT true, enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(slug, revision)
);
INSERT INTO plan_revisions VALUES
 ('free_v1','free',1,'Free',0,1,10800000,10,200000000,false,null,null,null,true,true,now()),
 ('developer_v1','developer',1,'Developer',20000000,10,72000000,50,2000000000,true,120000,12000000,null,true,true,now()),
 ('startup_v1','startup',1,'Startup',100000000,25,360000000,250,10000000000,true,100000,10000000,null,true,true,now())
 ON CONFLICT DO NOTHING;
CREATE TABLE account_subscriptions (
 account_id text PRIMARY KEY REFERENCES accounts(id), plan_revision_id text NOT NULL REFERENCES plan_revisions(id),
 paddle_subscription_id text UNIQUE, status text NOT NULL DEFAULT 'active',
 anchor_at timestamptz NOT NULL, period_start timestamptz NOT NULL, period_end timestamptz NOT NULL,
 pending_revision_id text REFERENCES plan_revisions(id), cancel_at_end boolean NOT NULL DEFAULT false,
 provider_updated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), CHECK(period_end > period_start)
);
CREATE TABLE subscription_periods (
 id text PRIMARY KEY, account_id text NOT NULL REFERENCES accounts(id),
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
 runs integer NOT NULL DEFAULT 0 CHECK(runs >= 0), browser_ms bigint NOT NULL DEFAULT 0 CHECK(browser_ms >= 0),
 proxy_bytes bigint NOT NULL DEFAULT 0 CHECK(proxy_bytes >= 0), browser_charged bigint NOT NULL DEFAULT 0,
 proxy_charged bigint NOT NULL DEFAULT 0, UNIQUE(account_id,starts_at), CHECK(ends_at > starts_at)
);
CREATE TABLE entitlement_history (
 id text PRIMARY KEY, account_id text NOT NULL REFERENCES accounts(id), plan_revision_id text NOT NULL REFERENCES plan_revisions(id),
 starts_at timestamptz NOT NULL DEFAULT now(), ends_at timestamptz, reason text NOT NULL
);
CREATE INDEX entitlement_history_account ON entitlement_history(account_id,starts_at);
CREATE TABLE execution_admissions (
 execution_id text PRIMARY KEY REFERENCES workflow_executions(id) ON DELETE CASCADE,
 period_id text NOT NULL REFERENCES subscription_periods(id), plan_revision_id text NOT NULL REFERENCES plan_revisions(id)
);
CREATE TABLE browser_usage_cursors (
 session_id text PRIMARY KEY REFERENCES browser_sessions(id), metered_at timestamptz NOT NULL
);
CREATE TABLE subscription_checkouts (
 id text PRIMARY KEY, account_id text NOT NULL REFERENCES accounts(id), plan_revision_id text NOT NULL REFERENCES plan_revisions(id),
 operation_id text NOT NULL, transaction_id text UNIQUE, checkout_url text, status text NOT NULL DEFAULT 'creating',
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(account_id,operation_id)
);
CREATE TABLE subscription_transactions (
 id text PRIMARY KEY, account_id text NOT NULL REFERENCES accounts(id), plan_revision_id text NOT NULL REFERENCES plan_revisions(id),
 subscription_id text NOT NULL, period_start timestamptz NOT NULL, period_end timestamptz NOT NULL,
 amount_micros bigint NOT NULL, occurred_at timestamptz NOT NULL, refunded_micros bigint NOT NULL DEFAULT 0
);
CREATE TABLE custom_plan_requests (
 id text PRIMARY KEY, account_id text NOT NULL REFERENCES accounts(id), message text NOT NULL,
 status text NOT NULL DEFAULT 'open', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE custom_plan_offers (
 id text PRIMARY KEY, email text NOT NULL, plan_revision_id text NOT NULL REFERENCES plan_revisions(id),
 expires_at timestamptz NOT NULL, claimed_account_id text REFERENCES accounts(id), created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE operating_costs ADD COLUMN plan_revision_id text REFERENCES plan_revisions(id);
ALTER TABLE captcha_jobs ALTER COLUMN reservation_id DROP NOT NULL;
ALTER TABLE challenge_attempts ALTER COLUMN reservation_id DROP NOT NULL;
INSERT INTO account_subscriptions(account_id,plan_revision_id,anchor_at,period_start,period_end)
 SELECT id,'free_v1',created_at,now(),now()+interval '1 month' FROM accounts;
INSERT INTO entitlement_history(id,account_id,plan_revision_id,reason)
 SELECT 'cutover:'||id,id,'free_v1','rollout' FROM accounts;
INSERT INTO billing_settings(key,value) VALUES ('subscription_cutover',jsonb_build_object('at',now())) ON CONFLICT DO NOTHING;

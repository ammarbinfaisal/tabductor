CREATE TABLE allowance_receipts (
 account_id text NOT NULL REFERENCES accounts(id), category text NOT NULL, source_id text NOT NULL,
 period_id text NOT NULL REFERENCES subscription_periods(id), plan_revision_id text NOT NULL REFERENCES plan_revisions(id),
 quantity bigint NOT NULL, charge_micros bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(account_id,category,source_id)
);
CREATE TABLE account_proxy_credentials (
 account_id text PRIMARY KEY REFERENCES accounts(id), hash text NOT NULL UNIQUE REFERENCES proxy_accounts(hash),
 envelope jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE proxy_usage_buckets (
 hash text NOT NULL, day date NOT NULL, bytes bigint NOT NULL, revision integer NOT NULL DEFAULT 1,
 PRIMARY KEY(hash,day)
);
CREATE TABLE subscription_adjustments (
 id text PRIMARY KEY, transaction_id text NOT NULL REFERENCES subscription_transactions(id), amount_micros bigint NOT NULL,
 status text NOT NULL, occurred_at timestamptz NOT NULL
);

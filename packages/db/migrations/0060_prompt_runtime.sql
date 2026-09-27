ALTER TABLE workflow_executions ADD COLUMN result_summary text;
ALTER TABLE workflow_executions ADD COLUMN runtime_status text;
ALTER TABLE workflow_executions ADD COLUMN finalization_status text NOT NULL DEFAULT 'pending';
ALTER TABLE workflow_executions ADD COLUMN finalization_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE workflow_executions ADD COLUMN finalization_claimed_at timestamptz;
ALTER TABLE workflow_executions ADD COLUMN finalization_error text;
ALTER TABLE runs ADD COLUMN result_json jsonb;
CREATE TABLE workflow_store_operations (
  workflow_id text NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  execution_id text NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
  operation_key text NOT NULL, request_hash text NOT NULL, result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (execution_id, operation_key)
);

--> statement-breakpoint
ALTER TABLE workflow_records ALTER COLUMN source_event_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE run_record_outcomes ADD COLUMN collection text NOT NULL DEFAULT 'records', ADD COLUMN record_key text NOT NULL DEFAULT 'record';
--> statement-breakpoint
ALTER TABLE run_record_outcomes DROP CONSTRAINT run_record_outcomes_pkey, ADD PRIMARY KEY (run_id, collection, record_key);

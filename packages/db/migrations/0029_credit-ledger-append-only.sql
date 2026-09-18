CREATE FUNCTION prevent_credit_ledger_mutation() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'credit_ledger_entries is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER credit_ledger_entries_append_only
BEFORE UPDATE OR DELETE ON "credit_ledger_entries"
FOR EACH ROW EXECUTE FUNCTION prevent_credit_ledger_mutation();

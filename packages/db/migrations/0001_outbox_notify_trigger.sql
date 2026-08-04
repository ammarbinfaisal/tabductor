-- Wake-up latch for the dispatcher (impl-phases Phase 1: "LISTEN/NOTIFY as a wake-up latch
-- to keep poll latency low without tight loops").
--
-- The NOTIFY lives in a trigger rather than in the publisher so that it fires for every
-- outbox insert regardless of who wrote the row, and so Postgres holds the notification
-- until the transaction commits — precisely the post-commit delivery a transactional
-- outbox needs. A rolled-back publish therefore never wakes anyone.
--
-- Payload is empty on purpose: this is a latch, not a channel. The dispatcher re-reads the
-- outbox under FOR UPDATE SKIP LOCKED, so a missed or coalesced notification costs one
-- poll interval of latency, never a lost event. FOR EACH STATEMENT (not ROW) keeps batched
-- inserts of 10k events to one notification.
CREATE OR REPLACE FUNCTION tabductor_outbox_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('tabductor_outbox', '');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER outbox_notify
AFTER INSERT ON outbox
FOR EACH STATEMENT
EXECUTE FUNCTION tabductor_outbox_notify();

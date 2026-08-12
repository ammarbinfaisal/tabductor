ALTER TABLE "tasks" ADD COLUMN "kind" text DEFAULT 'browser' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_kind_check" CHECK ("tasks"."kind" in ('browser','asset'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_kind_mode_check" CHECK (not ("tasks"."kind" = 'asset' and "tasks"."mode" = 'compiled'));--> statement-breakpoint
-- Schedule→asset is a cross-table rule ("a schedule may not bind to a kind=asset task",
-- techical_plan §5), so no single-table CHECK can express it. A constraint trigger is the
-- backstop for a direct insert/update that bypasses `publishVersion`'s zod check — the
-- control plane rejects the same shape earlier, at save time (§5: reject at save time, not
-- dispatch time), so this only ever fires against something that skipped it.
--
-- Written as a deny-on-asset, not an allowlist: `decision` (S5g) is schedulable by design,
-- so it must fall through this trigger untouched — the day that kind lands, this function's
-- body needs no edit, only `asset` stays denied.
CREATE OR REPLACE FUNCTION tabductor_schedule_deny_asset_kind() RETURNS trigger AS $$
DECLARE
  task_kind text;
BEGIN
  SELECT kind INTO task_kind FROM tasks WHERE id = NEW.task_id;
  IF task_kind = 'asset' THEN
    RAISE EXCEPTION 'schedules may not bind to a kind=asset task (task_id=%)', NEW.task_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER schedules_deny_asset_kind
AFTER INSERT OR UPDATE ON "schedules"
FOR EACH ROW
EXECUTE FUNCTION tabductor_schedule_deny_asset_kind();

-- +goose Up

-- Whatever else a school records about a member of staff.
--
-- students gained custom_fields for exactly this reason and employees never
-- did, so a school that keeps a teacher's UDISE code, their PF number, the
-- date their police verification expires or which bus they travel on had
-- nowhere to put it. The answer to "can we record X about our staff" was no,
-- and the workaround was the qualification field with a comma in it.
--
-- One jsonb column, merged rather than assigned by the endpoint that writes
-- it, so a screen that knows about three fields cannot erase a fourth it has
-- never heard of.

ALTER TABLE employees
    ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN employees.custom_fields IS
    'Fields this school records about staff that the product did not think of. '
    'Merged on write, never assigned, so one screen cannot wipe another''s.';

-- +goose Down
ALTER TABLE employees DROP COLUMN IF EXISTS custom_fields;

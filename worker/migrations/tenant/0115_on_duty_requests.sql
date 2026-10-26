-- 0115_on_duty_requests (tenant: every school database).
-- Owner, 2026-10-26: staff file "On duty / outside work" for a day or a range
-- (exam duty, board office, a trip), so the 6 PM auto-absent skips them. It is
-- a leave_requests row with kind 'on_duty'; these columns hold where they are
-- and, optionally, the hours away ("HH:MM").
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

ALTER TABLE leave_requests ADD COLUMN place TEXT;
ALTER TABLE leave_requests ADD COLUMN from_time TEXT;
ALTER TABLE leave_requests ADD COLUMN to_time TEXT;

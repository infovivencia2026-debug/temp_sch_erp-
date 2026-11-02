-- 0126_lesson_register_day_status (tenant: every school database).
-- A day of the school's micro schedule carries its own status (owner,
-- 2026-10-30: "nothing should miss"): a date the subject has no period in
-- the timetable (most Saturdays) still shows the topic and whether it was
-- completed, as on the sheet. Same three values as lesson_register.status.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

ALTER TABLE lesson_register_days ADD COLUMN status TEXT CHECK (status IS NULL OR status IN ('not_completed', 'ongoing', 'completed'));

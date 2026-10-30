-- 0124_absence_called_phone (tenant: every school database).
-- Records which guardian number was rung for each absence follow-up.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.


-- Which parent's number the office rang for an absence (owner, 2026-10-30:
-- the sheet with remarks shows who was called, with name and number).
-- Empty for rows saved before this, or when nobody was rung.
ALTER TABLE student_absence_followup ADD COLUMN called_phone TEXT NOT NULL DEFAULT '';

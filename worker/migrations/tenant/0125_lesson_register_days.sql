-- 0125_lesson_register_days (tenant: every school database).
-- The lesson plan register shows every date, like the school's own sheet
-- (owner, 2026-10-30): a day carries its type in the school's codes (TD
-- teaching day, HD holiday, ND non-teaching day, TED teaching + event day,
-- NED non-teaching event day) and, where no period is taught, what the day
-- was (a holiday's or an event's name). One row per class-section, subject
-- and date; a date with no row takes its type from the calendar.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

CREATE TABLE IF NOT EXISTS lesson_register_days (
  institution_id TEXT NOT NULL,
  section_id TEXT NOT NULL REFERENCES sections (id) ON DELETE CASCADE,
  class_subject_id TEXT NOT NULL REFERENCES class_subjects (id) ON DELETE CASCADE,
  on_date TEXT NOT NULL,
  day_type TEXT NOT NULL CHECK (day_type IN ('TD', 'HD', 'ND', 'TED', 'NED')),
  topic TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (section_id, class_subject_id, on_date)
);

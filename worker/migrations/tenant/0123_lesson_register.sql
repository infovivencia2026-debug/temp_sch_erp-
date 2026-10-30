-- 0123_lesson_register (tenant: every school database).
-- The lesson plan register (owner, 2026-10-30): one row per timetabled
-- period of a class's subject on a date, with the topic the teacher means to
-- teach and how far it got. Rows are worked out from the timetable and the
-- calendar; only a period somebody has written to is stored here. Status
-- moves forward only: not_completed -> ongoing -> completed.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

CREATE TABLE IF NOT EXISTS lesson_register (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  section_id TEXT NOT NULL REFERENCES sections (id) ON DELETE CASCADE,
  class_subject_id TEXT NOT NULL REFERENCES class_subjects (id) ON DELETE CASCADE,
  on_date TEXT NOT NULL,
  period_id TEXT NOT NULL REFERENCES periods (id) ON DELETE CASCADE,
  topic TEXT,
  status TEXT NOT NULL DEFAULT 'not_completed' CHECK (status IN ('not_completed', 'ongoing', 'completed')),
  updated_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (section_id, class_subject_id, on_date, period_id)
);
CREATE INDEX IF NOT EXISTS lesson_register_class_subject ON lesson_register (class_subject_id, section_id, on_date);

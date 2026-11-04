-- 0129_chapter_progress (tenant: every school database).
-- The lesson plan by chapter (owner, 2026-11-04): a class-section's
-- progress on each chapter and sub-topic of a subject's syllabus
-- (syllabus_units; a sub-topic is a unit with parent_unit_id). From and to
-- dates, the same three statuses as lesson_register (forward only), and a
-- note per chapter.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.


CREATE TABLE IF NOT EXISTS chapter_progress (
  institution_id TEXT NOT NULL,
  section_id TEXT NOT NULL REFERENCES sections (id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL REFERENCES syllabus_units (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'not_completed' CHECK (status IN ('not_completed', 'ongoing', 'completed')),
  from_date TEXT,
  to_date TEXT,
  note TEXT,
  updated_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (section_id, unit_id)
);
CREATE INDEX IF NOT EXISTS chapter_progress_unit ON chapter_progress (unit_id);

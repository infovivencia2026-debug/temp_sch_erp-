-- 0128_section_co_teachers (tenant: every school database).
-- More than one class teacher for a section (owner, 2026-11-04: a head of
-- pre-primary with every class-teacher feature in Nursery, Jr KG and Sr KG,
-- while each class keeps its own class teacher). sections.class_teacher_id
-- stays the named class teacher; this table holds the others, and the view
-- lists all of them for the access checks.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

CREATE TABLE IF NOT EXISTS section_co_teachers (
  section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (section_id, user_id)
);
CREATE INDEX IF NOT EXISTS section_co_teachers_user_idx ON section_co_teachers (user_id);

CREATE VIEW IF NOT EXISTS section_class_teachers AS
  SELECT id AS section_id, class_teacher_id AS user_id FROM sections WHERE class_teacher_id IS NOT NULL
  UNION
  SELECT section_id, user_id FROM section_co_teachers;

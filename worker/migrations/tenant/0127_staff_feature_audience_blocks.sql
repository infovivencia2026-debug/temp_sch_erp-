-- 0127_staff_feature_audience_blocks (tenant: every school database).
-- Screens hidden from one group of staff (owner, 2026-11-02: choose class
-- teacher, subject teacher or a role, then hide its screens). audience is
-- 'role:<role key>', 'duty:class_teacher' or 'duty:subject_teacher'.
-- staff_feature_blocks (0122) stays for screens hidden from all staff.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.


CREATE TABLE IF NOT EXISTS staff_feature_audience_blocks (
  audience TEXT NOT NULL,
  feature_slug TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (audience, feature_slug)
);

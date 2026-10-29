-- 0121_teacher_slot_same_subject (tenant: every school database).
-- A teacher may take two sections in the same period when it is the same
-- subject: a combined P.E.T class for both sections of a grade (owner,
-- 2026-10-27). Two different subjects at once is still refused, with the
-- same message the unique index gave, so callers that read it keep working.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

DROP INDEX IF EXISTS timetable_teacher_slot;

CREATE TRIGGER IF NOT EXISTS timetable_teacher_slot_i BEFORE INSERT ON timetable_entries
WHEN NEW.teacher_user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM timetable_entries t
    JOIN class_subjects a ON a.id = t.class_subject_id
    JOIN class_subjects b ON b.id = NEW.class_subject_id
   WHERE t.teacher_user_id = NEW.teacher_user_id AND t.weekday = NEW.weekday
     AND t.period_id = NEW.period_id AND t.academic_year_id = NEW.academic_year_id
     AND a.subject_id <> b.subject_id)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE constraint failed: timetable_entries.teacher_user_id, timetable_entries.weekday, timetable_entries.period_id, timetable_entries.academic_year_id');
END;

CREATE TRIGGER IF NOT EXISTS timetable_teacher_slot_u BEFORE UPDATE OF teacher_user_id, weekday, period_id, academic_year_id, class_subject_id ON timetable_entries
WHEN NEW.teacher_user_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM timetable_entries t
    JOIN class_subjects a ON a.id = t.class_subject_id
    JOIN class_subjects b ON b.id = NEW.class_subject_id
   WHERE t.id <> NEW.id AND t.teacher_user_id = NEW.teacher_user_id AND t.weekday = NEW.weekday
     AND t.period_id = NEW.period_id AND t.academic_year_id = NEW.academic_year_id
     AND a.subject_id <> b.subject_id)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE constraint failed: timetable_entries.teacher_user_id, timetable_entries.weekday, timetable_entries.period_id, timetable_entries.academic_year_id');
END;

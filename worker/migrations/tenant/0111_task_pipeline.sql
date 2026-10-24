-- 0111_task_pipeline (tenant: every school database).
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.
--
-- Staff tasks as a pipeline (owner, 2026-10-24: "make task pipeline and
-- handling tasks better, also visual, intuitive"). A task now moves To do ->
-- In progress -> Review -> Done: work handed over by someone else goes back
-- to them to accept or send back with a note (status 'review', a value of
-- the existing status column). Every step, edit and comment is kept here, so
-- a task carries its own story.

CREATE TABLE IF NOT EXISTS staff_task_updates (
  id TEXT NOT NULL PRIMARY KEY,
  institution_id TEXT NOT NULL REFERENCES institutions (id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES staff_tasks (id) ON DELETE CASCADE,
  by_user TEXT REFERENCES users (id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS staff_task_updates_task ON staff_task_updates (task_id, created_at);

-- The story of tasks given before this: when each was given, and when it was finished.
INSERT OR IGNORE INTO staff_task_updates (id, institution_id, task_id, by_user, kind, note, created_at)
  SELECT t.id || ':created', t.institution_id, t.id, t.assigned_by, 'created', NULL, t.created_at FROM staff_tasks t;
INSERT OR IGNORE INTO staff_task_updates (id, institution_id, task_id, by_user, kind, note, created_at)
  SELECT t.id || ':done', t.institution_id, t.id, NULL, 'accepted', t.done_note, t.done_at FROM staff_tasks t WHERE t.done_at IS NOT NULL;

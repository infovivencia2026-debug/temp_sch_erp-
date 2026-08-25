-- +goose Up
-- +goose StatementBegin

/* A reminder that arrives when the child asked for it.

   A diary note carried a date and nothing else, so "hand in the science
   project" sat on Thursday's page and reached nobody on Thursday. The child
   had to open the diary to be reminded by the diary, which is the one thing a
   reminder exists not to require.

   A time, and the moment it was sent. Both, because the second is what stops
   the sweep sending it again five minutes later — a reminder that arrives
   twice is worse than one that arrives late, and a nullable sent_at is the
   cheapest exactly-once this needs.

   Nullable: most notes are still just notes. A note about a maths problem does
   not want to interrupt anybody, and forcing a time on every one of them would
   turn the diary into an alarm clock. */
ALTER TABLE student_diary_notes
    ADD COLUMN IF NOT EXISTS remind_at   timestamptz,
    ADD COLUMN IF NOT EXISTS reminded_at timestamptz;

COMMENT ON COLUMN student_diary_notes.remind_at IS
    'When the child asked to be told. NULL means this note never interrupts.';
COMMENT ON COLUMN student_diary_notes.reminded_at IS
    'When the reminder actually went out. NULL and due means the sweep still owes it.';

/* The sweep's own index: due, not yet sent, oldest first.

   Partial, because the rows it must never look at are almost all of them —
   every note with no time on it, and every reminder already delivered. */
CREATE INDEX IF NOT EXISTS student_diary_notes_due_idx
    ON student_diary_notes (remind_at)
 WHERE remind_at IS NOT NULL AND reminded_at IS NULL;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS student_diary_notes_due_idx;
ALTER TABLE student_diary_notes
    DROP COLUMN IF EXISTS remind_at,
    DROP COLUMN IF EXISTS reminded_at;
-- +goose StatementEnd

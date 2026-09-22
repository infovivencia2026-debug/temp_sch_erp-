-- +goose Up
-- Reply, edit and unsend, on both conversation tables.
--
-- A thread about one child runs a year, and "about which day?" is the commonest
-- confusion in it, so a message can now quote the one it answers. A teacher who
-- sends to the wrong parent could not take it back; now they can, within a
-- window the handler enforces, and what is left behind says a message was
-- withdrawn rather than silently vanishing -- a school record that can lose a
-- line without trace is not a record.
--
-- reply_to is deliberately not a foreign key with ON DELETE CASCADE: quoting a
-- message that is later withdrawn should leave the quote in place, saying what
-- it said at the time.
ALTER TABLE staff_messages
    ADD COLUMN IF NOT EXISTS reply_to_id uuid,
    ADD COLUMN IF NOT EXISTS edited_at   timestamptz,
    ADD COLUMN IF NOT EXISTS deleted_at  timestamptz;

ALTER TABLE parent_teacher_messages
    ADD COLUMN IF NOT EXISTS reply_to_id uuid,
    ADD COLUMN IF NOT EXISTS edited_at   timestamptz,
    ADD COLUMN IF NOT EXISTS deleted_at  timestamptz;

-- The page query walks a thread newest-first; these are the columns it sorts on.
CREATE INDEX IF NOT EXISTS staff_messages_thread_time_idx
    ON staff_messages (party_a, party_b, sent_at DESC);
CREATE INDEX IF NOT EXISTS parent_teacher_messages_thread_time_idx
    ON parent_teacher_messages (student_id, parent_user_id, teacher_user_id, sent_at DESC);

-- +goose Down
DROP INDEX IF EXISTS staff_messages_thread_time_idx;
DROP INDEX IF EXISTS parent_teacher_messages_thread_time_idx;
ALTER TABLE staff_messages
    DROP COLUMN IF EXISTS reply_to_id,
    DROP COLUMN IF EXISTS edited_at,
    DROP COLUMN IF EXISTS deleted_at;
ALTER TABLE parent_teacher_messages
    DROP COLUMN IF EXISTS reply_to_id,
    DROP COLUMN IF EXISTS edited_at,
    DROP COLUMN IF EXISTS deleted_at;

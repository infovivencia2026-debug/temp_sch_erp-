-- +goose Up

/* When this child's family was last chased for fees.
 *
 * The defaulters screen reported it from the notifications table, which is
 * only half the story: a notification exists for a guardian who has an app
 * account, and most of the families a school chases by SMS have none. So a
 * school could text sixty families and the column still read "never" for every
 * one of them — which is worse than not showing it, because it invites a
 * second send.
 *
 * One column, written by every send whatever channel it used. Not derived:
 * the alternative is a join across notifications and the message log, and the
 * message log records an address rather than a child, so the join cannot be
 * made honestly.
 */
ALTER TABLE students
    ADD COLUMN IF NOT EXISTS last_fee_reminder_at timestamptz;

COMMENT ON COLUMN students.last_fee_reminder_at IS
    'When a fee reminder was last sent about this child, on any channel — '
    'written by the manual send and by the reminder plans.';

-- +goose Down
ALTER TABLE students DROP COLUMN IF EXISTS last_fee_reminder_at;

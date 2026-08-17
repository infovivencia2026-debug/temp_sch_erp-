-- +goose Up
-- Intentionally a no-op.
--
-- An earlier version of this migration added a partial unique index on
-- announcement_acks (announcement_id, user_id) WHERE student_id IS NULL, to
-- let staff acknowledge a circular without naming a child. That was wrong:
-- announcement_acks.student_id is NOT NULL, so the partial index can never
-- match a row and the case it was meant to support cannot exist.
--
-- An acknowledgement is always on behalf of one child — a guardian with two
-- children may consent for one and not the other — so the existing primary key
-- (announcement_id, user_id, student_id) is already the correct constraint.
SELECT 1;

-- +goose Down
SELECT 1;

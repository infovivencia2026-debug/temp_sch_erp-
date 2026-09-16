-- +goose Up

-- THE PASSWORD TYPED ON THE CLASSROOM BOARD.
--
-- A teacher who opens the ERP on the interactive panel signs in with the whole
-- class watching the keyboard. After a week of that, her password is known to
-- thirty children, and it is the same password that reaches her payslip and
-- the marks she has not released yet.
--
-- The day code is the alternative the school can switch on: one six-digit
-- code, the same for every teacher, different every day, accepted IN PLACE OF
-- the password for accounts that hold a teaching role. What a child learns by
-- watching is worth until midnight. The personal password never appears on a
-- shared screen.
--
-- It is derived, not stored: HMAC of the date under this secret, so there is
-- no row to write each morning and no job that can fail to write it. Turning
-- the feature off is NULLing the secret; regenerating it (the code was
-- shouted across the staffroom) is replacing it, which changes today's code
-- immediately.
ALTER TABLE institutions
    ADD COLUMN IF NOT EXISTS teacher_day_code_secret bytea;

COMMENT ON COLUMN institutions.teacher_day_code_secret IS
    'HMAC key for the teachers'' daily sign-in code. NULL means the feature is off.';

-- How the session was opened. A day-code session is the one that must not be
-- allowed to change the password: a child who takes the board after the
-- teacher walks out could otherwise set a password of their own and own the
-- account for good. The check happens in the password handler; this is the
-- fact it reads.
ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS via text NOT NULL DEFAULT 'password';

ALTER TABLE sessions
    ADD CONSTRAINT sessions_via_check CHECK (via IN ('password', 'day_code'));

-- +goose Down
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_via_check;
ALTER TABLE sessions DROP COLUMN IF EXISTS via;
ALTER TABLE institutions DROP COLUMN IF EXISTS teacher_day_code_secret;

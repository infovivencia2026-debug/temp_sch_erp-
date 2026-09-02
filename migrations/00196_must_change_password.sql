-- +goose Up
-- The password the office handed out, and the fact that it is still in use.
--
-- Logins are issued in bulk from a spreadsheet the school already has: the
-- sign-in name is the person's mobile number or email, and the first password
-- is that same number. That is the only pair a school can hand to four hundred
-- families and expect them to be able to use -- a generated code has to be
-- printed, delivered and typed correctly by somebody who has never seen the
-- system, and it is lost by the second week.
--
-- It is also, until it is changed, a password that anybody holding the class
-- list can guess. This column is what closes that: an account issued this way
-- cannot reach anything until the person sets a password of their own. The
-- credential is enough to prove they were given a login and nothing else.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN users.must_change_password IS
  'True while the account still carries the password the office issued. The '
  'API refuses everything except reading the session and setting a new '
  'password until it is false.';

-- +goose Down
ALTER TABLE users DROP COLUMN IF EXISTS must_change_password;

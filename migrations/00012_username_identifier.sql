-- +goose Up
-- Let a username stand on its own as a sign-in identifier.
--
-- 00010 added users.username and taught the login lookup to resolve it, but
-- left users_check as it was: "email IS NOT NULL OR phone IS NOT NULL". So the
-- system accepted a username at sign-in while the schema still refused to
-- store an account that had only one.
--
-- That gap is exactly the case a school needs. Most of the people in an Indian
-- K-12 school have neither a work email nor a phone the school may record — a
-- Class 6 child, a hostel warden, a teacher in a government school — and
-- inventing firstname@school.test for ninety of them creates a directory of
-- fictions that then has to be maintained. It surfaced the first time a tenant
-- was provisioned with a username alone, which is the ordinary case.
--
-- The rule the constraint should have expressed all along: an account needs at
-- least one way to be addressed.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_check;

ALTER TABLE users ADD CONSTRAINT users_has_identifier
    CHECK (email IS NOT NULL OR phone IS NOT NULL OR username IS NOT NULL);

COMMENT ON CONSTRAINT users_has_identifier ON users IS
    'An account must be addressable by at least one of email, phone or username.';

-- +goose Down
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_has_identifier;
ALTER TABLE users ADD CONSTRAINT users_check
    CHECK (email IS NOT NULL OR phone IS NOT NULL);

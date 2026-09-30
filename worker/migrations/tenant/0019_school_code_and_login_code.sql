-- The two columns the login scheme rests on, so a school joining tomorrow is
-- born with them rather than having them added by hand afterwards.
--
-- Both were put into the three existing schools directly while the scheme was
-- being worked out. That is the part that does not scale: the fourth school
-- would have arrived, its staff would have fallen back to employee codes, and
-- its logins would have failed to save a code at all -- quietly, because the
-- column simply would not be there.

-- WHAT THE SCHOOL IS CALLED IN A LOGIN.
--
-- One ERP serves many schools and every identifier is looked up across all of
-- them at once, so a staff number that is unique in one building is not unique
-- enough. Four capitals after their phone number say whose staff they are:
-- 9840010005.JSMH. Short enough to read down a telephone, and the only part of
-- a sign-in name that a school chooses for itself.
ALTER TABLE institutions ADD COLUMN school_code TEXT;

-- THE ONE NAME THAT NEVER CHANGES.
--
-- A phone number changes, a surname changes, an admission number is reissued
-- when a school renumbers, and an employee code is only unique inside one
-- school. Every identifier a person signs in with is borrowed from something
-- that can move. This one is the account's own: ten characters, drawn at
-- random, never reused, and the same for the life of the login.
--
-- Filled in by indexLogin the first time an account is touched, which is why
-- there is no default here: a code that was handed out must never be handed
-- out again, and a DEFAULT would give every row the same one.
ALTER TABLE users ADD COLUMN login_code TEXT;

-- Not UNIQUE: uniqueness for these is held in CONTROL.login_index, where every
-- school's identifiers meet and a collision between two schools can actually
-- be seen. A unique index here would only promise it within one school, which
-- is the promise that was not worth making.
CREATE INDEX IF NOT EXISTS users_login_code ON users (login_code);

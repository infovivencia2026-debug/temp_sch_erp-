-- +goose Up
-- A username to sign in with, alongside email and phone.
--
-- Every account had to be addressed by an email, which is wrong for a school
-- before it is inconvenient: most of a school's people do not have a work
-- address. A class teacher in a government school, a hostel warden, a Class 6
-- child — none of them have one, and inventing firstname@school.test for
-- ninety staff is a directory of fictions that then has to be maintained.
--
-- Unique per institution, like email and phone already are: two schools on one
-- installation may each have an "office" login, and the sign-in form resolves
-- the ambiguity the same way it does today, by refusing rather than guessing.
--
-- citext because nobody types their own username with consistent capitals.

ALTER TABLE users ADD COLUMN username citext;

-- Partial, so the many accounts with no username do not collide on NULL. This
-- is the trap the earlier migrations kept hitting: a nullable column inside a
-- plain UNIQUE constraint lets every NULL through, and the constraint quietly
-- enforces nothing.
CREATE UNIQUE INDEX users_institution_username
    ON users (institution_id, username)
 WHERE username IS NOT NULL;

-- A username must not be mistakable for one of the other two identifiers, or
-- the login lookup becomes ambiguous against itself: "9848012345" as a
-- username would match another account's phone, and an address with an @ in it
-- would shadow a real email.
ALTER TABLE users ADD CONSTRAINT users_username_shape
    CHECK (username IS NULL OR username ~ '^[a-z0-9][a-z0-9._-]{1,30}$');

COMMENT ON COLUMN users.username IS
    'Optional sign-in name, unique per institution. Lower case, no @, not all digits.';

-- +goose Down
DROP INDEX IF EXISTS users_institution_username;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_shape;
ALTER TABLE users DROP COLUMN IF EXISTS username;

-- +goose Up
-- Grant app_user the baseline tables it was never granted.
--
-- 00001 sets ALTER DEFAULT PRIVILEGES at line 3515, after it has already
-- created every baseline table. Default privileges apply to tables created
-- *after* the statement, so on a database built purely from migrations
-- app_user holds nothing on users, students, enrollments and the rest, while
-- every later migration's tables are fine.
--
-- The symptom is severe and points the wrong way: authenticate fails on
-- permission, Login renders it as 401 "Incorrect username or password", and a
-- correctly provisioned account simply cannot sign in with nothing in the log
-- to say why. The demo database predates the statement and was cloned rather
-- than migrated, which is why this went unnoticed.
--
-- Idempotent, and a no-op on any database where the grant already holds.

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- And repeat the default so tables created from here on are covered whichever
-- role creates them.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;

-- +goose Down
-- Deliberately empty: revoking these would lock the application out of its own
-- database, and the grant is what the schema intended from the beginning.
SELECT 1;

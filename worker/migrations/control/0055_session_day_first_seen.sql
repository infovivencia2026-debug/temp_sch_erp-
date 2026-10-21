-- 0055_session_day_first_seen (control: CONTROL only).
-- The staff header's "First" time: the first request a session made on the
-- school's current day. Stamped by the session touch (auth/session.ts) once
-- per session per local day, so a session signed in yesterday and used today
-- still reports today's first time.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

ALTER TABLE sessions ADD COLUMN day_first_seen_at TEXT;

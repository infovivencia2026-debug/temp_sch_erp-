-- +goose Up

-- Migration 246 backfilled nothing, and said it had.
--
-- It set pushed_at = now() on every notification that predated push
-- delivery, so the pump would not send a phone six months of old alerts as
-- though they were new. notifications carries FORCE ROW LEVEL SECURITY, the
-- migration ran with no tenant set, and the UPDATE matched zero rows and
-- reported success. That is the same shape as 181, which 182 redid, and it
-- is the case the migration lint added beside this file now refuses.
--
-- The consequence is live: the pump selects WHERE pushed_at IS NULL, so the
-- first run against a phone that registers a token would push the whole
-- backlog, two hundred per pass. Marking everything unpushed as pushed now
-- loses at most the minute of alerts the pump had not yet reached, which is
-- the trade 246 already chose.

SET LOCAL app.is_platform_admin = 'on';

UPDATE notifications SET pushed_at = now() WHERE pushed_at IS NULL;

-- +goose Down

-- Nothing to undo: the rows were never going to be pushed as new.

-- 0120_live_changes (tenant: every school database).
-- One row per table a write request changed, with a school-wide sequence
-- number (Yajur, 2026-10-27: a save by one user shows for every other user and
-- role). /portal/live hands out the names changed since a client's last
-- number; web/src/lib/live.ts refetches the screens that show them.
--
-- Forward-only: once applied anywhere this file must not change.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

CREATE TABLE IF NOT EXISTS live_changes (
  tbl TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS live_changes_seq_idx ON live_changes (seq);

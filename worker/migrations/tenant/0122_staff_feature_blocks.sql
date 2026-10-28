-- 0122_staff_feature_blocks (tenant: every school database).
-- Screens the school switches OFF for every member of staff (owner,
-- 2026-10-28: "hide My Pay for all the staff"). One row per screen slug; at
-- sign-in every staff role's key for that screen is taken away
-- (identity.ts), whatever role or roles the person holds.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

CREATE TABLE IF NOT EXISTS staff_feature_blocks (
  feature_slug TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

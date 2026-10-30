-- 0116_substitution_proposed_by (tenant: every school database).
-- Owner, 2026-10-27: the principal can Reject a pick on the substitution board,
-- and whoever made the pick is told. This column remembers who made it.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

ALTER TABLE substitution_request_periods ADD COLUMN proposed_by TEXT;

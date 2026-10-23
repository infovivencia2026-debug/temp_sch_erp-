-- 0106_visitor_parent_link (tenant: every school database).
-- A visitor pass can name the parent who came in, when the desk picked an
-- existing parent rather than typing a new name. Nullable: most visitors are
-- not parents, and every pass issued before this has none.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration.
-- ALTER TABLE ... ADD COLUMN cannot be re-run; _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

ALTER TABLE "visitors" ADD COLUMN "guardian_id" TEXT REFERENCES "guardians" ("id") ON DELETE SET NULL;

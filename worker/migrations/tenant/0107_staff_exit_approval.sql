-- 0107_staff_exit_approval (tenant: every school database).
-- An exit is no longer finished by HR alone: once every department has
-- signed, HR sends it to the institution admin, who approves (the person is
-- relieved and their login switched off) or sends it back with a note.
-- staff_exits.status gains 'pending_approval' and 'returned'; these columns
-- record who asked, who decided, when, and the note sent back.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration.
-- ALTER TABLE ... ADD COLUMN cannot be re-run; _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

ALTER TABLE "staff_exits" ADD COLUMN "approval_requested_by" TEXT REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "staff_exits" ADD COLUMN "approval_requested_at" TEXT;
ALTER TABLE "staff_exits" ADD COLUMN "decided_by" TEXT REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "staff_exits" ADD COLUMN "decided_at" TEXT;
ALTER TABLE "staff_exits" ADD COLUMN "decision_note" TEXT;

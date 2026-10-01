-- 0025_support_access_grants (tenant: every school database).
-- A support session's record could never be written. impersonation_grants
-- .operator_user_id referenced this school's users, and the operator is a
-- platform account, which lives in CONTROL: the insert was refused by the
-- foreign key, so "enter this school, and say why" failed and the register a
-- school's administrator reads stayed empty. The table is rebuilt without
-- that one reference (SQLite cannot drop a constraint in place). Every other
-- column, key and index is as it was; rows are carried across.
--
-- Forward-only. No BEGIN/COMMIT (D1 rejects them).

CREATE TABLE impersonation_grants_new (
  "id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))),
  "institution_id" TEXT NOT NULL,
  "operator_user_id" TEXT NOT NULL,
  "operator_name" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "ticket_id" TEXT,
  "started_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "expires_at" TEXT NOT NULL,
  "ended_at" TEXT,
  "ended_by" TEXT,
  "ended_by_name" TEXT,
  "ended_reason" TEXT,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("ended_by") REFERENCES "users" ("id") ON DELETE SET NULL,
  FOREIGN KEY ("institution_id") REFERENCES "institutions" ("id") ON DELETE CASCADE,
  FOREIGN KEY ("ticket_id") REFERENCES "support_tickets" ("id") ON DELETE SET NULL
);
INSERT INTO impersonation_grants_new (id, institution_id, operator_user_id, operator_name, reason, ticket_id, started_at, expires_at, ended_at, ended_by, ended_by_name, ended_reason)
  SELECT id, institution_id, operator_user_id, operator_name, reason, ticket_id, started_at, expires_at, ended_at, ended_by, ended_by_name, ended_reason FROM impersonation_grants;
DROP TABLE impersonation_grants;
ALTER TABLE impersonation_grants_new RENAME TO impersonation_grants;
CREATE INDEX "impersonation_grants_school" ON "impersonation_grants" ("institution_id", "started_at");
CREATE INDEX "impersonation_grants_live" ON impersonation_grants (operator_user_id, expires_at DESC) WHERE (ended_at IS NULL);

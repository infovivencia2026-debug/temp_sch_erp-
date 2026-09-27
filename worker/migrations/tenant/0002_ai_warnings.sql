-- 0002_ai_warnings (tenant: every school database).
-- Early warnings: risk flags computed nightly from attendance, marks, fees,
-- staff attendance and unmarked registers, each with its evidence numbers,
-- an owner and a status; plus a cache of the one-line explanations the AI
-- writes from that evidence (keyed by a hash of the evidence).
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration.

CREATE TABLE IF NOT EXISTS "ai_warnings" (
  "id" TEXT NOT NULL,
  "institution_id" TEXT NOT NULL,
  "rule" TEXT NOT NULL,
  "subject_kind" TEXT NOT NULL,
  "subject_id" TEXT NOT NULL,
  "subject_name" TEXT,
  "student_id" TEXT,
  "section_id" TEXT,
  "severity" TEXT NOT NULL DEFAULT 'medium',
  "owner_role" TEXT NOT NULL,
  "owner_user_id" TEXT,
  "evidence" TEXT NOT NULL DEFAULT '{}',
  "evidence_hash" TEXT NOT NULL DEFAULT '',
  "reason" TEXT NOT NULL DEFAULT '',
  "explanation" TEXT,
  "explained_by" TEXT,
  "next_step" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'open',
  "status_note" TEXT,
  "status_by" TEXT,
  "status_at" TEXT,
  "first_seen_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "last_seen_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "cleared_at" TEXT,
  PRIMARY KEY ("id"),
  UNIQUE ("rule", "subject_kind", "subject_id"),
  CHECK ("severity" IN ('low','medium','high')),
  CHECK ("status" IN ('open','acknowledged','resolved')),
  CHECK ("owner_role" IN ('class_teacher','accounts','principal'))
);
CREATE INDEX IF NOT EXISTS "ai_warnings_open" ON "ai_warnings" ("status", "cleared_at", "severity");
CREATE INDEX IF NOT EXISTS "ai_warnings_student" ON "ai_warnings" ("student_id");
CREATE INDEX IF NOT EXISTS "ai_warnings_section" ON "ai_warnings" ("section_id");

CREATE TABLE IF NOT EXISTS "ai_explanations" (
  "key" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY ("key")
);

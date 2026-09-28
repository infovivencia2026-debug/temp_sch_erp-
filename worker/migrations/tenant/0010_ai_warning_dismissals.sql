-- 0010_ai_warning_dismissals (tenant: every school database).
-- A person can wave an early warning away for themselves. It stays open for
-- everyone else it concerns (a principal clearing it does not clear it for the
-- class teacher), and it comes back if the nightly check raises it afresh.
CREATE TABLE IF NOT EXISTS "ai_warning_dismissals" (
  "warning_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "dismissed_at" TEXT NOT NULL,
  PRIMARY KEY ("warning_id", "user_id"),
  FOREIGN KEY ("warning_id") REFERENCES "ai_warnings" ("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "ai_warning_dismissals_by_user" ON "ai_warning_dismissals" ("user_id");

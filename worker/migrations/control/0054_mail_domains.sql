-- 0054_mail_domains (control: CONTROL only).
-- Staff Inbox: the school mail domain index.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.


-- Staff Inbox: which school an incoming email belongs to. Cloudflare Email
-- Routing hands every message to the Worker's email() handler; the recipient's
-- domain is looked up here, then the address in that school's mail_addresses.
-- One domain belongs to one school; the school's admin sets it on
-- Communication > Mail addresses.
CREATE TABLE IF NOT EXISTS "mail_domains" (
  "domain" TEXT NOT NULL COLLATE NOCASE,
  "institution_id" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY ("domain"),
  FOREIGN KEY ("institution_id") REFERENCES "institutions" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "mail_domains_institution_idx" ON "mail_domains" ("institution_id");

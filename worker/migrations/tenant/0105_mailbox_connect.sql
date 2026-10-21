-- 0105_mailbox_connect (tenant: every school database).
-- Each member of staff connects their own mailbox on the school's mail
-- server: mail they send goes out through it as them, and their old mail is
-- copied in over IMAP. The admin sets the server; nobody but the owner can
-- use or see a connection.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

-- The school's mail server, one row (id = 'school'). Empty host = not set.
-- smtp_security: tls (implicit, usually 465) | starttls (usually 587).
-- IMAP is always implicit TLS (usually 993).
CREATE TABLE IF NOT EXISTS "mail_server" (
  "id" TEXT NOT NULL,
  "imap_host" TEXT NOT NULL DEFAULT '',
  "imap_port" INTEGER NOT NULL DEFAULT 993,
  "smtp_host" TEXT NOT NULL DEFAULT '',
  "smtp_port" INTEGER NOT NULL DEFAULT 465,
  "smtp_security" TEXT NOT NULL DEFAULT 'tls',
  "updated_by" TEXT,
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY ("id")
);

-- One connection per person. secret: the mailbox password sealed as
-- integrations.credentials are (AES-256-GCM under CREDENTIAL_KEY); no route
-- returns it. The login name is the person's address in mail_addresses.
-- import_state: none | queued | running | done | failed.
-- import_cursor: JSON {sent_name, folders: [{name, target, uidvalidity, last_uid}]}.
CREATE TABLE IF NOT EXISTS "mail_connections" (
  "user_id" TEXT NOT NULL,
  "secret" BLOB NOT NULL,
  "connected_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "import_state" TEXT NOT NULL DEFAULT 'none',
  "import_done" INTEGER NOT NULL DEFAULT 0,
  "import_total" INTEGER NOT NULL DEFAULT 0,
  "import_cursor" TEXT,
  "import_error" TEXT,
  "import_updated_at" TEXT,
  PRIMARY KEY ("user_id"),
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE
);

-- Import and inbound skip a message already in the mailbox by Message-ID.
CREATE INDEX IF NOT EXISTS "mail_messages_message_id_idx" ON "mail_messages" ("user_id", "message_id");

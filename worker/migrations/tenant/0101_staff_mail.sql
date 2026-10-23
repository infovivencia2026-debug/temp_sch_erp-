-- 0100_staff_mail (tenant: every school database).
-- Staff Inbox: addresses, messages and attachments.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.


-- Staff Inbox (communication.inbox, communication.mail_addresses): a real
-- email address per member of staff. Mail arrives through Cloudflare Email
-- Routing (src/services/mail.ts receiveMail) and leaves through the school's
-- email channel. Every read is scoped to the signed-in user's own rows; the
-- admin assigns addresses and never reads mail.

-- One address per person. status: active | disabled (a disabled address
-- refuses incoming mail and cannot send; its mail is kept).
CREATE TABLE IF NOT EXISTS "mail_addresses" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "address" TEXT NOT NULL COLLATE NOCASE,
  "status" TEXT NOT NULL DEFAULT 'active',
  "created_by" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY ("id"),
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "mail_addresses_user_idx" ON "mail_addresses" ("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "mail_addresses_address_idx" ON "mail_addresses" ("address");

-- One row per message per mailbox. folder: inbox | sent | trash.
-- Addresses lists are JSON arrays of {name, address}. html_body is kept as
-- received; the web shows it only inside a sandboxed frame with scripts off.
-- thread_key groups a conversation: the first Message-ID of its References.
CREATE TABLE IF NOT EXISTS "mail_messages" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "folder" TEXT NOT NULL DEFAULT 'inbox',
  "trashed_from" TEXT,
  "from_address" TEXT NOT NULL DEFAULT '',
  "from_name" TEXT NOT NULL DEFAULT '',
  "to_list" TEXT NOT NULL DEFAULT '[]',
  "cc_list" TEXT NOT NULL DEFAULT '[]',
  "subject" TEXT NOT NULL DEFAULT '',
  "snippet" TEXT NOT NULL DEFAULT '',
  "text_body" TEXT NOT NULL DEFAULT '',
  "html_body" TEXT,
  "message_id" TEXT,
  "in_reply_to" TEXT,
  "references_list" TEXT,
  "thread_key" TEXT,
  "read_at" TEXT,
  "starred" INTEGER NOT NULL DEFAULT 0,
  "has_attachments" INTEGER NOT NULL DEFAULT 0,
  "send_status" TEXT,
  "send_error" TEXT,
  "received_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY ("id"),
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "mail_messages_box_idx" ON "mail_messages" ("user_id", "folder", "received_at");
CREATE INDEX IF NOT EXISTS "mail_messages_unread_idx" ON "mail_messages" ("user_id", "folder", "read_at");
CREATE INDEX IF NOT EXISTS "mail_messages_thread_idx" ON "mail_messages" ("user_id", "thread_key");

-- Attachments of incoming mail, the bytes in R2 (FILES_WRITE) under r2_key.
CREATE TABLE IF NOT EXISTS "mail_attachments" (
  "id" TEXT NOT NULL,
  "message_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "filename" TEXT NOT NULL DEFAULT '',
  "content_type" TEXT NOT NULL DEFAULT 'application/octet-stream',
  "size_bytes" INTEGER NOT NULL DEFAULT 0,
  "r2_key" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY ("id"),
  FOREIGN KEY ("message_id") REFERENCES "mail_messages" ("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "mail_attachments_message_idx" ON "mail_attachments" ("message_id");

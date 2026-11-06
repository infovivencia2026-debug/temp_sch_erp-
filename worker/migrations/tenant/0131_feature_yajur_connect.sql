-- 0131_feature_yajur_connect (tenant: every school database).
-- Yajur Connect: two-way WhatsApp chat with parents. Inbound messages from the
-- WhatsApp webhook are kept here per number; replies are queued through
-- message_log like every other send, so the recipient guard still decides.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

-- Yajur Connect (communication.yajur_connect), added by `npm run feature:new` (scripts/feature.mjs).
-- Brings every existing school database up to what a new school is provisioned with.

-- The permission vocabulary: new capability keys and the catalogue (navigation) keys.
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('institution_admin.communication.yajur_connect', 'institution_admin', 'WhatsApp chats with parents in one place. Read what parents send, reply inside the 24-hour window or with an approved template after it, assign a chat to a colleague, label it, resolve it, and set keyword auto-replies.');

-- The built-in roles pick them up. A school that customised a role keeps its customisation.
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'institution_admin.communication.yajur_connect' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.connect.read' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.connect.write' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;

-- One chat per WhatsApp number. guardian_id / student_id are the best match
-- for the number when the chat was opened (or relinked); either may be null.
-- labels: JSON array of short strings. state: open | resolved.
CREATE TABLE IF NOT EXISTS wa_conversations (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  profile_name TEXT,
  guardian_id TEXT REFERENCES guardians (id) ON DELETE SET NULL,
  student_id TEXT REFERENCES students (id) ON DELETE SET NULL,
  assigned_to TEXT REFERENCES users (id) ON DELETE SET NULL,
  labels TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
  unread INTEGER NOT NULL DEFAULT 0,
  last_inbound_at TEXT,
  last_message_at TEXT,
  last_preview TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wa_conversations_last_idx ON wa_conversations (last_message_at);

-- Every message in a chat. direction in | out. kind: text, image, document,
-- audio, video, sticker, reaction, location, template, ... media_id is
-- WhatsApp's media id (not downloaded). wa_id is WhatsApp's message id for
-- inbound; message_log_id ties an outbound row to the queue, whose status
-- (queued, sent, delivered, read, failed, suppressed) is shown.
CREATE TABLE IF NOT EXISTS wa_messages (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES wa_conversations (id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  kind TEXT NOT NULL DEFAULT 'text',
  text TEXT,
  media_id TEXT,
  media_mime TEXT,
  media_name TEXT,
  reply_to_wa_id TEXT,
  wa_id TEXT UNIQUE,
  message_log_id TEXT,
  status TEXT,
  sent_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  auto_reply_id TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wa_messages_conv_idx ON wa_messages (conversation_id, at);

-- Keyword auto-replies, checked against each inbound text in position order.
CREATE TABLE IF NOT EXISTS wa_autoreplies (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  match_type TEXT NOT NULL CHECK (match_type IN ('exact', 'starts', 'contains')),
  keyword TEXT NOT NULL,
  reply TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

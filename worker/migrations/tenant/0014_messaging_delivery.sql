-- 0014_messaging_delivery (tenant: every school database).
-- Cheap, reliable, non-spammy messaging (services/delivery.ts):
--   * a channel ladder per message type, cheapest first, set by the school;
--   * de-duplication, a daily digest, quiet hours and a per-recipient cap;
--   * delivery receipts per message and recipient, fed by provider webhooks;
--   * idempotency keys on sends.
--
-- Additive only. Forward-only. No BEGIN/COMMIT (D1 rejects them).

-- The school's delivery rules. One row per school; absent means the defaults
-- in services/delivery.ts (digest 18:00, quiet 21:00-07:00 IST, cap 6/day,
-- the same alert to the same person once per 6 hours).
CREATE TABLE IF NOT EXISTS message_settings (
  institution_id TEXT NOT NULL PRIMARY KEY REFERENCES institutions (id) ON DELETE CASCADE,
  digest_time TEXT NOT NULL DEFAULT '18:00',
  quiet_from TEXT,
  quiet_to TEXT,
  daily_cap INTEGER NOT NULL DEFAULT 6,
  dedup_minutes INTEGER NOT NULL DEFAULT 360,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT
);

-- A school's own ladder for one message type (otp, absence, notice, ...).
-- ladder: JSON list of channels, cheapest first. mode: 'instant' | 'digest'.
CREATE TABLE IF NOT EXISTS message_policies (
  institution_id TEXT NOT NULL REFERENCES institutions (id) ON DELETE CASCADE,
  message_type TEXT NOT NULL,
  ladder TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'instant',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  PRIMARY KEY (institution_id, message_type)
);

-- Non-urgent items waiting for the recipient's daily digest.
CREATE TABLE IF NOT EXISTS message_digest_items (
  id TEXT NOT NULL PRIMARY KEY,
  institution_id TEXT NOT NULL REFERENCES institutions (id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users (id) ON DELETE CASCADE,
  recipient TEXT NOT NULL,
  message_type TEXT NOT NULL,
  template_code TEXT,
  title TEXT NOT NULL,
  body TEXT,
  source_kind TEXT,
  source_id TEXT,
  dedup_key TEXT,
  reason TEXT NOT NULL DEFAULT 'digest',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  digest_message_id TEXT,
  bundled_at TEXT
);
CREATE INDEX IF NOT EXISTS message_digest_items_pending ON message_digest_items (institution_id, created_at) WHERE bundled_at IS NULL;
CREATE INDEX IF NOT EXISTS message_digest_items_source ON message_digest_items (source_kind, source_id);

-- Every status a provider reported for a message: the receipt trail.
CREATE TABLE IF NOT EXISTS message_events (
  id TEXT NOT NULL PRIMARY KEY,
  institution_id TEXT NOT NULL REFERENCES institutions (id) ON DELETE CASCADE,
  message_log_id TEXT NOT NULL REFERENCES message_log (id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  provider TEXT,
  detail TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS message_events_by_message ON message_events (message_log_id, occurred_at);

-- Receipts, the ladder and idempotency on the log itself.
ALTER TABLE message_log ADD COLUMN read_at TEXT;
ALTER TABLE message_log ADD COLUMN failed_at TEXT;
ALTER TABLE message_log ADD COLUMN message_type TEXT;
ALTER TABLE message_log ADD COLUMN ladder TEXT;
ALTER TABLE message_log ADD COLUMN fallback_of TEXT;
ALTER TABLE message_log ADD COLUMN dedup_key TEXT;
ALTER TABLE message_log ADD COLUMN idempotency_key TEXT;
ALTER TABLE message_log ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS message_log_idempotency ON message_log (institution_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS message_log_dedup ON message_log (dedup_key, queued_at) WHERE dedup_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS message_log_provider_msg ON message_log (provider_msg_id) WHERE provider_msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS message_log_by_source ON message_log (source_kind, source_id) WHERE source_kind IS NOT NULL;
CREATE INDEX IF NOT EXISTS message_log_recipient_day ON message_log (recipient, queued_at);

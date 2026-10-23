-- A group chat for each subject (owner, 2026-10-19): the subject head and
-- every teacher of the subject in one thread, which the principal can read.
-- Forward-only: once applied anywhere this file must not change.
CREATE TABLE IF NOT EXISTS subject_chat_messages (
  id TEXT NOT NULL PRIMARY KEY,
  institution_id TEXT NOT NULL,
  subject_id TEXT NOT NULL REFERENCES subjects (id) ON DELETE CASCADE,
  sender_user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS subject_chat_messages_subject ON subject_chat_messages (subject_id, sent_at);

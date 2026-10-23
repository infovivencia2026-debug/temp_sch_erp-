-- 0053_ai_key (CONTROL).
-- The platform's Google (Gemini) key, set by a seller admin under
-- Controls > AI, and the last check of whichever key is in use.
--
-- One row (id = 1). sealed: the key sealed with CREDENTIAL_KEY (AES-GCM, the
--   connector credential seal, routes/admin/providers.ts); NULL means "use the
--   GOOGLE_API_KEY secret". last4 and set_at describe the stored key; the key
--   itself is never returned by any route.
-- state / checked_at / key_fp: the result of the last check (ok, refused,
--   quota, unreachable) for the key whose fingerprint is key_fp (a short
--   SHA-256 prefix), so a changed key is checked again.
CREATE TABLE IF NOT EXISTS ai_key (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  sealed     BLOB,
  last4      TEXT,
  set_at     TEXT,
  set_by     TEXT,
  state      TEXT,
  checked_at TEXT,
  key_fp     TEXT
);

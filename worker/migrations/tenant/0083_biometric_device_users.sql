-- The people a biometric reader knows, by its own id and the name enrolled on
-- it (owner, 2026-10-13: "map it by phone number and names"). The X2008 sends
-- punches under ids like YPS0006 that match no staff code, so the reader's
-- user list is asked for alongside Fetch history and kept here; a reader id
-- whose name matches exactly one member of staff is linked to them, and the
-- punches already received under it are matched. Readers hold no phone
-- numbers, so the name is the only bridge.
-- Forward-only: once applied anywhere this file must not change.
CREATE TABLE IF NOT EXISTS biometric_device_users (
  institution_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES biometric_devices (id) ON DELETE CASCADE,
  device_user_id TEXT NOT NULL,
  name TEXT,
  card TEXT,
  privilege INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (device_id, device_user_id)
);

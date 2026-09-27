-- control_features (CONTROL D1 only). Per-school feature switches and
-- targeted platform announcements with read tracking. Idempotent; apply with
--   npm run migrate -- up (was db/changes/control_features.sql)

-- A seller's override of one catalogue feature for one school, on top of what
-- the plan's modules give. feature_id is '<section>.<feature>' (the catalogue
-- key without its role, so one switch covers every role that shows it).
-- enabled 1 = on even if the plan leaves the module out; 0 = off even if the
-- plan includes it. ends_at (optional) is when the override lapses and the
-- plan default returns: a trial, or a temporary switch-off.
CREATE TABLE IF NOT EXISTS school_feature_overrides (
  institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  feature_id TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  ends_at TEXT,
  note TEXT NOT NULL DEFAULT '',
  set_by TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (institution_id, feature_id)
);
CREATE INDEX IF NOT EXISTS school_feature_overrides_feature ON school_feature_overrides(feature_id);

-- Who a platform broadcast is for. No row = every school, every audience
-- (the broadcasts raised before this table existed).
-- target_kind: all | group | plan | schools; target_ids: JSON list of group
-- ids, plan codes or institution ids. audiences: JSON list drawn from
-- admins, staff, parents (parents includes students).
CREATE TABLE IF NOT EXISTS platform_broadcast_targets (
  broadcast_id TEXT PRIMARY KEY REFERENCES platform_broadcasts(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL DEFAULT 'all' CHECK (target_kind IN ('all','group','plan','schools')),
  target_ids TEXT NOT NULL DEFAULT '[]',
  audiences TEXT NOT NULL DEFAULT '["admins","staff","parents"]',
  updated_at TEXT NOT NULL
);

-- Who has seen / dismissed a broadcast, per school user.
CREATE TABLE IF NOT EXISTS platform_broadcast_reads (
  broadcast_id TEXT NOT NULL REFERENCES platform_broadcasts(id) ON DELETE CASCADE,
  institution_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  dismissed_at TEXT,
  PRIMARY KEY (broadcast_id, institution_id, user_id)
);
CREATE INDEX IF NOT EXISTS platform_broadcast_reads_school ON platform_broadcast_reads(broadcast_id, institution_id);

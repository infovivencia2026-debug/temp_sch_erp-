-- 0020_feature_class_status (tenant: every school database).
-- Class Status: a photo or a short video a teacher (or the school itself)
-- posts to a section, a class, the whole school or the staff, seen by the
-- families, children and staff in that audience for 24 hours unless pinned
-- to the class gallery. Bytes live in FILES_WRITE under
-- class-status/<institution>/ and are served only through
-- GET /status/posts/{id}/media after an audience check
-- (src/routes/comms/class_status.ts). The school's switch and rules are
-- module_settings module 'class_status' (src/services/class_status.ts).
--
-- Forward-only. Re-runnable (IF NOT EXISTS, INSERT OR IGNORE).
-- No BEGIN/COMMIT (D1 rejects them).

CREATE TABLE IF NOT EXISTS status_posts (
  id TEXT NOT NULL PRIMARY KEY,
  institution_id TEXT NOT NULL,
  posted_by TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- 1: posted as the school (its name and logo), not as the person.
  as_school INTEGER NOT NULL DEFAULT 0,
  -- photo | video
  media_kind TEXT NOT NULL,
  object_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  -- Seconds, as the poster's browser read it (video only).
  duration_seconds REAL,
  caption TEXT,
  -- pending (waiting for the principal) | live | rejected
  status TEXT NOT NULL DEFAULT 'live',
  -- Kept in the class gallery after the 24 hours.
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- When it went live, and 24 hours after that; NULL while pending.
  published_at TEXT,
  expires_at TEXT,
  decided_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS status_posts_live ON status_posts (status, expires_at);
CREATE INDEX IF NOT EXISTS status_posts_poster ON status_posts (posted_by, created_at);

-- Who it is for: one row per target. kind school | staff (target_id '')
-- or class | section (target_id the class or section).
CREATE TABLE IF NOT EXISTS status_post_targets (
  post_id TEXT NOT NULL REFERENCES status_posts (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  target_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (post_id, kind, target_id)
);
CREATE INDEX IF NOT EXISTS status_post_targets_target ON status_post_targets (kind, target_id);

-- One row per person per post: the first time they opened it. student_id is
-- the child through whom a parent is in the audience, for the poster's list.
CREATE TABLE IF NOT EXISTS status_views (
  post_id TEXT NOT NULL REFERENCES status_posts (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  student_id TEXT REFERENCES students (id) ON DELETE SET NULL,
  viewed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS status_views_user ON status_views (user_id);

-- Class Status (communication.class_status), added by `npm run feature:new` (scripts/feature.mjs).
-- Brings every existing school database up to what a new school is provisioned with.

-- The permission vocabulary: new capability keys and the catalogue (navigation) keys.
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('status.post', 'status', 'Post a class status (photo or short video) to own sections, classes or the school');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('status.manage', 'status', 'Every class status in the school: approve, delete, pin, and the settings');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('status.post_school', 'status', 'Post a status as the school, with its name and logo');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('faculty.communication.class_status', 'faculty', 'Post a photo or a short video to your section, your class or the whole school, like a WhatsApp status: it disappears after 24 hours unless you pin it to the class gallery. See who has viewed each post.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('institution_admin.communication.class_status', 'institution_admin', 'Every live and pinned status in the school with who posted it, its audience and how many have seen it; post as the school, approve teachers'' posts, delete or pin any post, and set the rules: on or off, approval, who may post, video and its length.');

-- The built-in roles pick them up. A school that customised a role keeps its customisation.
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'faculty.communication.class_status' FROM roles WHERE key = 'faculty' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'status.post' FROM roles WHERE key IN ('faculty', 'class_teacher', 'institution_admin') AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'status.manage' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'status.post_school' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'institution_admin.communication.class_status' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;

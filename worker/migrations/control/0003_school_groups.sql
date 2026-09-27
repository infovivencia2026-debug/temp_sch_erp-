-- control_school_groups (CONTROL D1 only). School groups, group admins and
-- the cross-school board membership index. Idempotent; apply with
--   npm run migrate -- up (was db/changes/control_school_groups.sql)
-- then open Seller → Board members once to backfill board_memberships.
-- One organisation owning several schools ("Yajur Branch 1", "Yajur Branch
-- 2"). Each school keeps its own database; the group is only a label here
-- plus who may look across it. Not Go's franchises (a brand/royalty contract,
-- empty in production): a group is ownership.
CREATE TABLE IF NOT EXISTS school_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_by TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A school is in at most one group.
CREATE TABLE IF NOT EXISTS school_group_members (
  institution_id TEXT PRIMARY KEY REFERENCES institutions(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES school_groups(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS school_group_members_group ON school_group_members(group_id);

-- Group admins: a school user (signed in at their home school) who is a
-- board member of every school in the group and may read its combined report.
CREATE TABLE IF NOT EXISTS school_group_admins (
  group_id TEXT NOT NULL REFERENCES school_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  home_institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS school_group_admins_user ON school_group_admins(user_id);

-- Board memberships across schools. The grant itself is a board_member
-- user_roles row in the overseen school's own database; this index is how a
-- request learns, before opening any school, which schools a user may switch
-- into (GET /me/institutions, X-Acting-Institution in identity.ts). Written
-- by the /seller/board-members and /seller/school-groups handlers; rebuilt
-- from the schools by GET /seller/board-members. via_group names the group
-- that granted it (NULL = granted directly), so leaving a group removes only
-- what the group gave.
CREATE TABLE IF NOT EXISTS board_memberships (
  user_id TEXT NOT NULL,
  institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  home_institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  via_group TEXT REFERENCES school_groups(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, institution_id)
);

-- Features switched OFF for students or parents, in bulk (owner, 2026-10-10:
-- "let them choose to remove for single person, whole school or class wise
-- ... make a filter to choose in bulk"). One row = one portal feature key off
-- for one target. Sign-in subtracts these keys (identity.ts); only student.*
-- and parent.* keys are ever stored, so no staff access can be affected.
--   scope 'school'  : every student (or parent) login; target_id NULL
--   scope 'class'   : students enrolled in the class / parents of them
--   scope 'section' : the same, for one section
--   scope 'person'  : one login (target_id = users.id)
-- Forward-only: once applied anywhere this file must not change.
CREATE TABLE IF NOT EXISTS feature_blocks (
  id TEXT PRIMARY KEY,
  portal TEXT NOT NULL CHECK (portal IN ('student', 'parent')),
  feature_key TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('school', 'class', 'section', 'person')),
  target_id TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS feature_blocks_one ON feature_blocks (feature_key, scope, target_id);
CREATE INDEX IF NOT EXISTS feature_blocks_target ON feature_blocks (scope, target_id);

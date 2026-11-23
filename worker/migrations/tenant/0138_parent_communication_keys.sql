-- 0138_parent_communication_keys (tenant: every school database).
-- The parent's Messages section became a Communication group (2026-11-19):
-- parent.messages.communication split into parent.communication.concerns and
-- parent.communication.circulars_from_school, and parent.messages.teacher_remarks
-- became parent.communication.teacher_remarks. New schools are provisioned with
-- the new keys, but every existing school's roles, direct grants and switch-offs
-- still named the old ones, so parents could not open Circulars or Concerns
-- ("No such feature") and a school's "off" for Teacher remarks stopped applying
-- (owner, 2026-11-23).
--
-- Rename by carrying, not by guessing: whoever held an old key gets the new
-- key(s) — system roles, customised roles and per-user grants alike — and every
-- switch-off moves with it. Old keys are left in place (unused, harmless).
--
-- Forward-only: once applied anywhere this file must not change. Re-runnable:
-- every statement is INSERT OR IGNORE or keyed on the old name.

-- The permission vocabulary.
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('parent.communication.concerns', 'parent', 'Raise a concern with the front desk and follow it to its reply: what you asked, who is handling it and what they said.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('parent.communication.circulars_from_school', 'parent', 'Every circular and announcement the school has published for your family, newest first, with the ones that ask to be acknowledged marked.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('parent.communication.teacher_remarks', 'parent', 'Write a remark about one of your child''s teachers. It reaches the head of department and the teacher.');

-- Roles that held an old key get the new one(s).
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT role_id, 'parent.communication.concerns' FROM role_permissions WHERE permission_key = 'parent.messages.communication';
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT role_id, 'parent.communication.circulars_from_school' FROM role_permissions WHERE permission_key = 'parent.messages.communication';
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT role_id, 'parent.communication.teacher_remarks' FROM role_permissions WHERE permission_key = 'parent.messages.teacher_remarks';

-- People given an old key directly get the new one(s).
INSERT OR IGNORE INTO user_permissions (user_id, institution_id, permission_key, granted_by, granted_at) SELECT user_id, institution_id, 'parent.communication.concerns', granted_by, granted_at FROM user_permissions WHERE permission_key = 'parent.messages.communication';
INSERT OR IGNORE INTO user_permissions (user_id, institution_id, permission_key, granted_by, granted_at) SELECT user_id, institution_id, 'parent.communication.circulars_from_school', granted_by, granted_at FROM user_permissions WHERE permission_key = 'parent.messages.communication';
INSERT OR IGNORE INTO user_permissions (user_id, institution_id, permission_key, granted_by, granted_at) SELECT user_id, institution_id, 'parent.communication.teacher_remarks', granted_by, granted_at FROM user_permissions WHERE permission_key = 'parent.messages.teacher_remarks';

-- A school's switch-offs follow the rename. Copy under a derived id (so a re-run
-- adds nothing twice), then drop the old rows.
INSERT OR IGNORE INTO feature_blocks (id, portal, feature_key, scope, target_id, created_by, created_at) SELECT id || '-concerns', portal, 'parent.communication.concerns', scope, target_id, created_by, created_at FROM feature_blocks WHERE feature_key = 'parent.messages.communication';
INSERT OR IGNORE INTO feature_blocks (id, portal, feature_key, scope, target_id, created_by, created_at) SELECT id || '-circulars', portal, 'parent.communication.circulars_from_school', scope, target_id, created_by, created_at FROM feature_blocks WHERE feature_key = 'parent.messages.communication';
INSERT OR IGNORE INTO feature_blocks (id, portal, feature_key, scope, target_id, created_by, created_at) SELECT id || '-remarks', portal, 'parent.communication.teacher_remarks', scope, target_id, created_by, created_at FROM feature_blocks WHERE feature_key = 'parent.messages.teacher_remarks';
DELETE FROM feature_blocks WHERE feature_key IN ('parent.messages.communication', 'parent.messages.teacher_remarks');

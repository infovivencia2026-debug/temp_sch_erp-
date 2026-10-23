-- 0066_leave_windows_handbook (tenant: every school database).
--
-- Two things from the MyClassBoard comparison:
--   leave_policy_rules.window_from / window_to   a leave type that may only be
--        applied for inside a window of the year (MM-DD to MM-DD), such as
--        earned leave in April and October. Empty means any time.
--   the Staff handbook screens (HR and each staff member's own), which keep
--        policies as circulars of kind 'policy'; staff_announcement_acks holds
--        each member of staff's own acknowledgement.
--
-- Forward-only: once applied anywhere this file must not change.

ALTER TABLE leave_policy_rules ADD COLUMN window_from TEXT;
ALTER TABLE leave_policy_rules ADD COLUMN window_to TEXT;

-- announcement_acks keys on (announcement, user, student) and requires the
-- student: it is a family's acknowledgement. A member of staff signs for
-- themselves, so their acknowledgement has its own row.
CREATE TABLE IF NOT EXISTS staff_announcement_acks (
  announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  acked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (announcement_id, user_id)
);

INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('hr.handbook.staff_handbook', 'hr', 'The school''s policies for staff, each one acknowledged by every member of staff, and who has not yet read it.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('faculty.my_profile.my_handbook', 'faculty', 'The school''s policies you are asked to read and acknowledge.');
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'hr.handbook.staff_handbook' FROM roles WHERE key = 'hr' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'faculty.my_profile.my_handbook' FROM roles WHERE key = 'faculty' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.announcements.write' FROM roles WHERE key = 'hr' AND is_system = 1 AND customised_at IS NULL;

-- 0104_inbox_all_staff (tenant: every school database).
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.
-- Inbox for every staff role (owner, 2026-10-19: all staff can open the Inbox).
-- comms.mail.read + comms.mail.write (not comms.mail.manage) to the built-in staff
-- roles that lacked them, and the Inbox menu entry for Board / Trustee and LMS Admin.
-- A school that customised a role keeps its customisation.

INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('board_member.communication.inbox', 'board_member', 'Your own school email address. Read what arrives, reply, write new mail and keep it in folders. Only you can open your mailbox.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('lms_admin.communication.inbox', 'lms_admin', 'Your own school email address. Read what arrives, reply, write new mail and keep it in folders. Only you can open your mailbox.');

INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'vice_principal' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'vice_principal' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'it_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'it_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'hod' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'hod' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'operations' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'operations' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'faculty' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'faculty' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'subject_head' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'subject_head' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'class_teacher' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'class_teacher' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'exam_controller' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'exam_controller' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'finance' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'finance' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'admissions' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'admissions' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'front_office' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'front_office' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'board_member' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'board_member' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'hr' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'hr' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'librarian' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'librarian' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'hostel_warden' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'hostel_warden' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'transport_manager' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'transport_manager' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'driver' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'driver' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'counsellor' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'counsellor' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'nurse' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'nurse' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'discipline_officer' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'discipline_officer' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'activity_coord' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'activity_coord' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'lms_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'lms_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'board_member.communication.inbox' FROM roles WHERE key = 'board_member' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'lms_admin.communication.inbox' FROM roles WHERE key = 'lms_admin' AND is_system = 1 AND customised_at IS NULL;

-- 0098_feature_inbox (tenant: every school database).
-- Inbox: the screen keys and the comms.mail.read / comms.mail.write grants.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

-- Inbox (communication.inbox), added by `npm run feature:new` (scripts/feature.mjs).
-- Brings every existing school database up to what a new school is provisioned with.

-- The permission vocabulary: new capability keys and the catalogue (navigation) keys.
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('comms.mail.read', 'comms', 'View Inbox');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('comms.mail.write', 'comms', 'Manage Inbox');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('institution_admin.communication.inbox', 'institution_admin', 'Your own school email address. Read what arrives, reply, write new mail and keep it in folders. Only you can open your mailbox.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('hod.communication.inbox', 'hod', 'Your own school email address. Read what arrives, reply, write new mail and keep it in folders. Only you can open your mailbox.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('exam_controller.communication.inbox', 'exam_controller', 'Your own school email address. Read what arrives, reply, write new mail and keep it in folders. Only you can open your mailbox.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('faculty.communication.inbox', 'faculty', 'Your own school email address. Read what arrives, reply, write new mail and keep it in folders. Only you can open your mailbox.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('librarian.communication.inbox', 'librarian', 'Your own school email address. Read what arrives, reply, write new mail and keep it in folders. Only you can open your mailbox.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('transport_manager.communication.inbox', 'transport_manager', 'Your own school email address. Read what arrives, reply, write new mail and keep it in folders. Only you can open your mailbox.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('operations.communication.inbox', 'operations', 'Your own school email address. Read what arrives, reply, write new mail and keep it in folders. Only you can open your mailbox.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('driver.communication.inbox', 'driver', 'Your own school email address. Read what arrives, reply, write new mail and keep it in folders. Only you can open your mailbox.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('nurse.communication.inbox', 'nurse', 'Your own school email address. Read what arrives, reply, write new mail and keep it in folders. Only you can open your mailbox.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('counsellor.communication.inbox', 'counsellor', 'Your own school email address. Read what arrives, reply, write new mail and keep it in folders. Only you can open your mailbox.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('discipline_officer.communication.inbox', 'discipline_officer', 'Your own school email address. Read what arrives, reply, write new mail and keep it in folders. Only you can open your mailbox.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('hostel_warden.communication.inbox', 'hostel_warden', 'Your own school email address. Read what arrives, reply, write new mail and keep it in folders. Only you can open your mailbox.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('activity_coord.communication.inbox', 'activity_coord', 'Your own school email address. Read what arrives, reply, write new mail and keep it in folders. Only you can open your mailbox.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('finance.communication.inbox', 'finance', 'Your own school email address. Read what arrives, reply, write new mail and keep it in folders. Only you can open your mailbox.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('admissions.communication.inbox', 'admissions', 'Your own school email address. Read what arrives, reply, write new mail and keep it in folders. Only you can open your mailbox.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('front_office.communication.inbox', 'front_office', 'Your own school email address. Read what arrives, reply, write new mail and keep it in folders. Only you can open your mailbox.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('hr.communication.inbox', 'hr', 'Your own school email address. Read what arrives, reply, write new mail and keep it in folders. Only you can open your mailbox.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('it_admin.communication.inbox', 'it_admin', 'Your own school email address. Read what arrives, reply, write new mail and keep it in folders. Only you can open your mailbox.');

-- The built-in roles pick them up. A school that customised a role keeps its customisation.
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'institution_admin.communication.inbox' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'hod.communication.inbox' FROM roles WHERE key = 'hod' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'exam_controller.communication.inbox' FROM roles WHERE key = 'exam_controller' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'faculty.communication.inbox' FROM roles WHERE key = 'faculty' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'librarian.communication.inbox' FROM roles WHERE key = 'librarian' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'transport_manager.communication.inbox' FROM roles WHERE key = 'transport_manager' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'operations.communication.inbox' FROM roles WHERE key = 'operations' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'driver.communication.inbox' FROM roles WHERE key = 'driver' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'nurse.communication.inbox' FROM roles WHERE key = 'nurse' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'counsellor.communication.inbox' FROM roles WHERE key = 'counsellor' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'discipline_officer.communication.inbox' FROM roles WHERE key = 'discipline_officer' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'hostel_warden.communication.inbox' FROM roles WHERE key = 'hostel_warden' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'activity_coord.communication.inbox' FROM roles WHERE key = 'activity_coord' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'finance.communication.inbox' FROM roles WHERE key = 'finance' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'admissions.communication.inbox' FROM roles WHERE key = 'admissions' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'front_office.communication.inbox' FROM roles WHERE key = 'front_office' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'hr.communication.inbox' FROM roles WHERE key = 'hr' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'it_admin.communication.inbox' FROM roles WHERE key = 'it_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'hod' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'hod' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'exam_controller' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'exam_controller' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'faculty' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'faculty' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'librarian' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'librarian' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'transport_manager' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'transport_manager' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'operations' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'operations' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'driver' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'driver' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'nurse' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'nurse' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'counsellor' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'counsellor' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'discipline_officer' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'discipline_officer' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'hostel_warden' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'hostel_warden' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'activity_coord' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'activity_coord' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'finance' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'finance' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'admissions' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'admissions' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'front_office' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'front_office' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'hr' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'hr' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.read' FROM roles WHERE key = 'it_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.write' FROM roles WHERE key = 'it_admin' AND is_system = 1 AND customised_at IS NULL;

-- Every member of staff applies for leave, not only teachers and HODs
-- (owner, 2026-10-08: the transport manager had no "apply leave"). Adds
-- "Leave & self service" under My profile for each staff role, granted the
-- way 0064 granted its screens. Additive only: nothing is removed.
-- Forward-only: once applied anywhere this file must not change.

INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('exam_controller.my_profile.leave_self_service', 'exam_controller', 'Apply for your own leave and see where each request has got to: pending, approved or turned down.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('librarian.my_profile.leave_self_service', 'librarian', 'Apply for your own leave and see where each request has got to: pending, approved or turned down.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('transport_manager.my_profile.leave_self_service', 'transport_manager', 'Apply for your own leave and see where each request has got to: pending, approved or turned down.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('operations.my_profile.leave_self_service', 'operations', 'Apply for your own leave and see where each request has got to: pending, approved or turned down.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('driver.my_profile.leave_self_service', 'driver', 'Apply for your own leave and see where each request has got to: pending, approved or turned down.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('nurse.my_profile.leave_self_service', 'nurse', 'Apply for your own leave and see where each request has got to: pending, approved or turned down.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('counsellor.my_profile.leave_self_service', 'counsellor', 'Apply for your own leave and see where each request has got to: pending, approved or turned down.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('discipline_officer.my_profile.leave_self_service', 'discipline_officer', 'Apply for your own leave and see where each request has got to: pending, approved or turned down.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('hostel_warden.my_profile.leave_self_service', 'hostel_warden', 'Apply for your own leave and see where each request has got to: pending, approved or turned down.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('activity_coord.my_profile.leave_self_service', 'activity_coord', 'Apply for your own leave and see where each request has got to: pending, approved or turned down.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('finance.my_profile.leave_self_service', 'finance', 'Apply for your own leave and see where each request has got to: pending, approved or turned down.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('admissions.my_profile.leave_self_service', 'admissions', 'Apply for your own leave and see where each request has got to: pending, approved or turned down.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('front_office.my_profile.leave_self_service', 'front_office', 'Apply for your own leave and see where each request has got to: pending, approved or turned down.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('hr.my_profile.leave_self_service', 'hr', 'Apply for your own leave and see where each request has got to: pending, approved or turned down.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('it_admin.my_profile.leave_self_service', 'it_admin', 'Apply for your own leave and see where each request has got to: pending, approved or turned down.');
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'exam_controller.my_profile.leave_self_service' FROM roles WHERE key = 'exam_controller';
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'librarian.my_profile.leave_self_service' FROM roles WHERE key = 'librarian';
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'transport_manager.my_profile.leave_self_service' FROM roles WHERE key = 'transport_manager';
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'operations.my_profile.leave_self_service' FROM roles WHERE key = 'operations';
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'driver.my_profile.leave_self_service' FROM roles WHERE key = 'driver';
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'nurse.my_profile.leave_self_service' FROM roles WHERE key = 'nurse';
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'counsellor.my_profile.leave_self_service' FROM roles WHERE key = 'counsellor';
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'discipline_officer.my_profile.leave_self_service' FROM roles WHERE key = 'discipline_officer';
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'hostel_warden.my_profile.leave_self_service' FROM roles WHERE key = 'hostel_warden';
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'activity_coord.my_profile.leave_self_service' FROM roles WHERE key = 'activity_coord';
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'finance.my_profile.leave_self_service' FROM roles WHERE key = 'finance';
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'admissions.my_profile.leave_self_service' FROM roles WHERE key = 'admissions';
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'front_office.my_profile.leave_self_service' FROM roles WHERE key = 'front_office';
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'hr.my_profile.leave_self_service' FROM roles WHERE key = 'hr';
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'it_admin.my_profile.leave_self_service' FROM roles WHERE key = 'it_admin';

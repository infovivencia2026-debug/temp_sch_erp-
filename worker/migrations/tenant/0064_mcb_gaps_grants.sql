-- 0064_mcb_gaps_grants (tenant: every school database).
--
-- The four screens 0063 added to the catalogue, granted to the roles that
-- own them, the way 0030 granted the Helpdesk: only to a system role the
-- school has not customised, so a school that trimmed a role keeps its own
-- choice. New schools get the same rows from provision_seed.ts.
--
-- Forward-only: once applied anywhere this file must not change.

INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('finance.banking_reports.fixed_reports', 'finance', 'The sheets an accountant asks for by name: cheque deposits, the bank pay-in slip, outstanding as at a month end, fee plan details, month-wise, parent bank details, card charges.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('hr.tasks.staff_tasks', 'hr', 'Hand a job to a member of staff with a due date, the report of who has what open, and who each person reports to.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('faculty.my_profile.my_tasks', 'faculty', 'The jobs the office or your reporting manager handed you, and the ones you hand to your team.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('librarian.library.reading_levels', 'librarian', 'Each child''s measured reading level, who was never measured or is overdue, and the titles at each level.');

INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'finance.banking_reports.fixed_reports' FROM roles WHERE key = 'finance' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'hr.tasks.staff_tasks' FROM roles WHERE key = 'hr' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'faculty.my_profile.my_tasks' FROM roles WHERE key = 'faculty' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'librarian.library.reading_levels' FROM roles WHERE key = 'librarian' AND is_system = 1 AND customised_at IS NULL;

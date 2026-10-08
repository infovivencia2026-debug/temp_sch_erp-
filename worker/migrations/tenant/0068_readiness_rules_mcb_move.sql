-- 0068_readiness_rules_mcb_move (tenant: every school database).
--
-- Three screens for the principal: Rules (the settings the school makes
-- once), Move from MyClassBoard (the guided import), Returns readiness
-- (what UDISE+, APAAR, RTE and the training return still need). Granted
-- to the principal's system role the way 0064 granted its screens.
-- Forward-only: once applied anywhere this file must not change.

INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('institution_admin.getting_started.rules', 'institution_admin', 'The things the school decides once and the product does every day, each on or off with its one setting.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('institution_admin.getting_started.move_from_myclassboard', 'institution_admin', 'Bring a school across from MyClassBoard: which export to download, how its columns map, a dry run, the import.');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('institution_admin.standard.returns_readiness', 'institution_admin', 'What UDISE+, APAAR, the RTE register and the staff training return still need, counted today.');
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'institution_admin.getting_started.rules' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'institution_admin.getting_started.move_from_myclassboard' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'institution_admin.standard.returns_readiness' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;

-- 0099_feature_mail_addresses (tenant: every school database).
-- Mail addresses: the admin screen key and the comms.mail.manage grant.
--
-- Forward-only: once applied anywhere this file must not change (its
-- checksum is recorded); fix a mistake with a new migration. Make it
-- re-runnable where SQLite allows (CREATE ... IF NOT EXISTS, INSERT OR IGNORE).
-- ALTER TABLE ... ADD COLUMN cannot be; that is fine, _migrations guards it.
-- No BEGIN/COMMIT (D1 rejects them). After editing: npm run schema:sync.

-- Mail addresses (communication.mail_addresses), added by `npm run feature:new` (scripts/feature.mjs).
-- Brings every existing school database up to what a new school is provisioned with.

-- The permission vocabulary: new capability keys and the catalogue (navigation) keys.
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('comms.mail.manage', 'comms', 'View Mail addresses');
INSERT OR IGNORE INTO permissions (key, module, description) VALUES ('institution_admin.communication.mail_addresses', 'institution_admin', 'The school''s mail domain and each staff member''s email address: give one, change it or switch it off. Mail itself stays private to its owner.');

-- The built-in roles pick them up. A school that customised a role keeps its customisation.
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'institution_admin.communication.mail_addresses' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;
INSERT OR IGNORE INTO role_permissions (role_id, permission_key) SELECT id, 'comms.mail.manage' FROM roles WHERE key = 'institution_admin' AND is_system = 1 AND customised_at IS NULL;
